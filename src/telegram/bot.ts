import { Api, TelegramClient } from 'telegram';
import config from '../config';
import { BigInteger } from 'big-integer';
import tickets from './tickets';
import { accounts, activeTickets, cleanGroup, cleanTicketGroup, closeTicket, createTicket, startTicket } from './telegram';
import { EditMessageParams, SendMessageParams } from 'telegram/client/messages';
import { telegramCollection } from '../manager/database';
import tgutils from './tgutils';
import fs from 'fs';
import { StoreSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import getText from '../texts';
import { Button } from 'telegram/tl/custom/button';
import { getTransaction } from '../manager/manager';
import { parseTimeToMillisecons } from '../utils';
import { captureException, captureMessage } from '@sentry/node';

let client: TelegramClient;

let username: string | undefined;
let selfId: BigInteger | undefined;

const groupCache: { g: Api.Channel; t: number }[] = [];

// t is Date.now()
const userCache: { u: Api.User; t: number }[] = [];

// key is chat id, value is last message
const chatLimits: { [key: number]: number } = {};

async function callbackHandler(event: Api.UpdateBotCallbackQuery) {
	if (event.data?.toString() == 'create_ticket') {
		try {
			const username = tgutils.getUsername(await getUserById(event.userId, true));
			if (!username) {
				await client.invoke(
					new Api.messages.SetBotCallbackAnswer({
						queryId: event.queryId,
						message: `To use this button you need to have a username set on your account.\n\nOtherwise you can create a ticket by using /create in @${accounts
							.find((a) => a.details.main)
							?.getUsername()}'s DMs.`,
						alert: true,
					})
				);
				return;
			}

			const resp = await createTicket(username);
			if (resp) {
				await client.invoke(
					new Api.messages.SetBotCallbackAnswer({
						queryId: event.queryId,
						message: resp.message,
						alert: true,
					})
				);
			}
		} catch (e) {
			console.error(e);
			captureException(e);

			await client.invoke(
				new Api.messages.SetBotCallbackAnswer({
					queryId: event.queryId,
					message: 'There was an error creating your ticket. Please try again later.',
					alert: true,
				})
			);
		}

		return;
	} else if (event.data?.toString() == 'participate_giveaway') {
	}

	if (event.data) {
		try {
			await tickets.onCallback(event);
		} catch (e) {
			console.error(e);
		}
	}
}

// only used for admin commands
async function messageHandler(event: NewMessageEvent) {
	const message = event.message;
	if (
		!event.isGroup ||
		!message.text.startsWith('/') ||
		!message.fromId ||
		message.fromId.className != 'PeerUser' ||
		!message.peerId ||
		message.peerId.className != 'PeerChannel'
	) {
		return;
	}

	const user = await getUserById(message.fromId.userId);
	if (!user || !tgutils.isStaff(user)) {
		return;
	}

	const args = message.text.split(' ');
	const command = args.shift()?.toLowerCase().replace('/', '');

	switch (command) {
		case 'setup':
			await sendMessage(message.peerId, {
				message: getText('telegram/ticketpanel'),
				buttons: Button.inline('Start Middleman', Buffer.from('create_ticket', 'utf-8')),
				replyTo: message.replyToMsgId,
			});
			break;
		case 'giveaway':
			{
				client
					.deleteMessages(message.peerId, [message.id], {
						revoke: true,
					})
					.catch((e) => {
						console.error(e.message || e);
						captureException(e);
					});

				let dur = 0;
				try {
					dur = parseTimeToMillisecons(args[0]);
					if (!dur || dur <= 0) {
						throw new Error('Duration needs to be more than 0');
					}
				} catch (e: any) {
					await sendMessage(
						message.peerId,
						{
							message: e.message || 'Invalid duration',
							replyTo: message.id,
						},
						1000
					);
					break;
				}

				const winners = parseInt(args[1]);
				if (!winners || winners < 1) {
					await sendMessage(
						message.peerId,
						{
							message: 'Invalid winners count',
							replyTo: message.id,
						},
						1000
					);
					break;
				}

				const prize = args.slice(2).join(' ');
				// todo
				//new Api.InputPeerUser
			}
			break;
		case 'forceclose':
			if (!tgutils.isStaff(user)) {
				await sendMessage(
					message.peerId,
					{
						message: 'You are not allowed to use this command',
						replyTo: message.id,
					},
					1000
				);
				break;
			}

			const chatId = message.peerId.channelId;
			const ticket = activeTickets.find((t) => !t.closed && !t.closing && chatId.eq(t.group));

			if (ticket && (ticket.closing || ticket.closed)) {
				await sendMessage(
					message.peerId,
					{
						message: 'Ticket is already closing',
						replyTo: message.id,
					},
					1000
				);
			}

			const delay = args.length > 1 ? parseInt(args[1]) : undefined;
			if (delay) {
				await sendMessage(message.peerId, {
					message: 'Ticket will close in ' + delay + ' seconds',
					replyTo: message.id,
				});
			}

			if (ticket) {
				await closeTicket(ticket, delay ? delay * 1000 : undefined);
			} else {
				for (const acc of accounts) {
					const group = await acc.getGroupById(chatId);
					if (!group || !group.creator) {
						continue;
					}

					await cleanGroup(acc, group, undefined);
				}
			}
			break;
	}
}

async function setup() {
	if (!config.telegram.botToken) {
		console.warn('[BOT] No bot token provided');
		return;
	}

	// this path will be ./sessions/<user id>.session
	//const sessionPath = `./sessions/${config.telegram.botToken.split(':')[0]}.session`;

	if (!fs.existsSync('./sessions')) {
		fs.mkdirSync('./sessions');
	}

	client = new TelegramClient(new StoreSession('sessions/bot'), config.telegram.apiId, config.telegram.apiHash, {
		connectionRetries: 5,
	});

	client.setParseMode('html');
	await client.start({
		botAuthToken: config.telegram.botToken,
		onError: (e) => {
			console.error(e);
			captureException(e);
		},
	});

	/*setInterval(() => {
		fs.writeFileSync(sessionPath, (client.session.save() as any)?.toString() || '');
	}, 500);*/

	const me = (await client.getMe()) as Api.User;
	selfId = me.id;
	username = me.username || (me.usernames && me.usernames.length > 0 ? me.usernames[0].username : undefined);

	if (!username) {
		console.error('[BOT] Failed to get username!');
		process.exit();
	}

	console.log(`[BOT] Logged into @${username} (${selfId})`);

	client.addEventHandler(messageHandler, new NewMessage({}));
	client.addEventHandler((event) => {
		if (event.className == 'UpdateBotCallbackQuery') {
			callbackHandler(event as Api.UpdateBotCallbackQuery).catch((e) => {
				console.error(e);
				captureException(e);
			});
		}
	});

	// auto closer
	let runningCheck = false;
	setInterval(async () => {
		if (runningCheck) {
			return;
		}

		runningCheck = true;
		try {
			// the only time we dont automatically close ticket is if theres funds inside. select_address and ongoing are the only stages that have funds
			const active = activeTickets.filter((t) => t && !t.closed && !t.closing && t.stage != 'select_address' && t.stage != 'ongoing');

			for (const ticket of active) {
				if (ticket.tid) {
					// if its partial dont close it
					try {
						if ((await getTransaction(ticket.tid)).getStatus() == 'partial') {
							continue;
						}
					} catch {}
				}

				let peer: Api.Channel | undefined;
				peer = await getGroupPeer(ticket.group);
				if (!peer) {
					const msg = 'Failed to get group peer: ' + ticket.id;

					captureMessage(msg);
					console.error('[BOT]', msg);

					// the ticket gets added to list before the bot is added
					// we need to wait 15 seconds, and if that still doesnt add the bot then reset it
					if (Date.now() - ticket.created.getTime() > 1000 * 15) {
						await closeTicket(ticket);
					}
					continue;
				}

				let members: Api.channels.TypeChannelParticipants;

				try {
					members = await client.invoke(new Api.channels.GetParticipants({ channel: peer, filter: new Api.ChannelParticipantsRecent(), limit: 20 }));
				} catch (e: any) {
					console.error(e.message || e);
					captureException(e);

					// this only happens when group has been deleted and the cached peer hasnt been updated
					if (e.message.includes('CHANNEL_PRIVATE')) {
						await closeTicket(ticket, 3000);
						continue;
					}
					continue;
				}

				if (members.className != 'channels.ChannelParticipants') {
					console.error('[BOT] Failed to get participants: ' + ticket.id);
					continue;
				}

				if (members.participants.length == 0) {
					console.warn(`[BOT] No participants in ${ticket.id}`);
					continue;
				}

				let isUser1 = members.participants.find((p) => p.className == 'ChannelParticipant' && p.userId.eq(ticket.user1.id));
				let isUser2 = ticket.user2 && members.participants.find((p) => p.className == 'ChannelParticipant' && p.userId.eq(ticket.user2?.id || 0));

				let closeReason: string | undefined;
				if (!isUser1 && !isUser2 && ticket.stage == 'user_wait' && Date.now() - ticket.created.getTime() > 1000 * 60 * 5) {
					// waits 5 minutes without any users inside ticket before closing
					closeReason = `Closing ticket [${ticket.id}] because user #1 left the group`;
				} else if (!isUser1 && !isUser2 && ticket.stage != 'waiting' && Date.now() - (ticket.updated || ticket.created).getTime() > 1000 * 60 * 60 * 6) {
					// waits 6 hours without any users inside ticket before closing
					closeReason = `Closing ticket [${ticket.id}] because no users are in the group`;
				} else if (Date.now() - (ticket.updated || ticket.created).getTime() > 1000 * 60 * 60 * (ticket.stage == 'pending' ? 48 : 24)) {
					// no need to worry about ongoing transactions. this will only close tickets that are not holding funds
					closeReason = `Closing ticket [${ticket.id}] because it has been partially open for over 24 hours`;
				} else if (ticket.stage == 'waiting' && !isUser1 && Date.now() - ticket.created.getTime() > 1000 * 60 * 5) {
					closeReason = `Closing ticket [${ticket.id}] because user 1 never joined`;
				}

				if (closeReason) {
					console.log(`[BOT] ${closeReason}`);

					await closeTicket(ticket);
					continue;
				}

				if (ticket.stage == 'user_wait' && !ticket.user2) {
					// find the user 2
					const possible = members.participants.filter(
						// make sure they are a regular participant, they dont equal user 1, and they arent a host
						(p) => p.className == 'ChannelParticipant' && !p.userId.eq(ticket.user1.id) && !accounts.some((a) => a.getId()?.eq(p.userId))
					);
					if (possible.length == 0) {
						continue;
					}

					// loop through all participants and fetch their user info
					// this is used to filter out bots
					for (const part of possible) {
						if (part.className != 'ChannelParticipant') {
							continue;
						}

						try {
							// 5 hour cache
							const user = await getUserById(part.userId);

							if (!user || user.bot) {
								continue;
							}

							// if the user is not a bot, we can assume they are the user 2
							ticket.user2 = {
								id: user.id.toJSNumber(),
								name: tgutils.getName(user),
							};

							await tickets.setStage(ticket, 'define', true);
							await telegramCollection.updateOne({ id: ticket.id }, { $set: { user2: ticket.user2, stage: ticket.stage, updated: ticket.updated } });
							await tickets.initStage(ticket);
						} catch (e) {
							console.error(e);
							captureException(e);
						}
					}
				} else if (ticket.stage == 'waiting' && isUser1) {
					const host = accounts.find((a) => a.getId()?.eq(ticket.host));
					if (!host) {
						await sendMessage(peer, {
							message: 'There are no hosts available to start this ticket. Please create a new ticket.',
						});

						await closeTicket(ticket, 3000);
						continue;
					}

					const group = await host.getGroupById(ticket.group);
					if (!group) {
						await sendMessage(peer, {
							message: 'The host of this ticket is no longer in the group. Please create a new ticket.',
						});

						await closeTicket(ticket, 3000);
						continue;
					}

					await startTicket(group, host);
				}
			}
		} catch (e) {
			console.error(e);
			captureException(e);
		} finally {
			runningCheck = false;
		}
	}, config.telegram.checkMembersDelay);

	let lastConnected = Date.now();
	setInterval(() => {
		if (client.connected) {
			lastConnected = Date.now();
			return;
		}

		if (!client.connected && Date.now() - lastConnected > 10000) {
			client.connect();
		}
	}, 1000);
}

async function sendMessage(chat: Api.Channel | Api.PeerChannel | number | undefined, message: SendMessageParams, rateLimit?: number) {
	if (!chat) {
		return;
	}

	if (typeof chat == 'number') {
		const group = await getGroupPeer(chat);
		if (group) {
			chat = group;
		}
	}

	const chatId = typeof chat == 'number' ? chat : chat.className == 'PeerChannel' ? chat.channelId.toJSNumber() : chat.id.toJSNumber();
	if (rateLimit && rateLimit > 0 && Date.now() - chatLimits[chatId] < rateLimit) {
		return;
	}

	chatLimits[chatId] = Date.now();
	await client.sendMessage(chat, message);
}

async function editMessage(chat: Api.Channel | Api.PeerChannel | number | undefined, message: EditMessageParams) {
	if (!chat) {
		return;
	}

	if (typeof chat == 'number') {
		const group = await getGroupPeer(chat);
		if (group) {
			chat = group;
		}
	}

	await client.editMessage(chat, message);
}

// returns singler group
async function getGroupPeer(id: number): Promise<Api.Channel | undefined> {
	const groups = await getGroupPeers(id);
	if (groups.length == 0) {
		return undefined;
	}

	return groups.find((g) => g.id.eq(id));
}

// returns multiple groups
async function getGroupPeers(ids: number[] | number): Promise<Api.Channel[]> {
	const peers: Api.Channel[] = [];

	if (typeof ids == 'number') {
		ids = [ids];
	}

	for (const id of ids) {
		const cached = groupCache.find((g) => g.g.id.eq(id));
		if (!cached) {
			continue;
		}

		if (Date.now() - cached.t < 1000 * 60 * 60 * 5) {
			peers.push(cached.g);
			ids.splice(ids.indexOf(id), 1);
			continue;
		}

		groupCache.splice(groupCache.indexOf(cached), 1);
	}

	// send one by one just incase one doesnt exist anymore
	for (const id of ids) {
		try {
			const groups = await client.invoke(new Api.channels.GetChannels({ id: [tgutils.toChatId(id)] }));
			if (!groups || groups.className != 'messages.Chats') {
				continue;
			}

			for (const group of groups.chats) {
				if (group.className != 'Channel') {
					continue;
				}

				groupCache.push({
					g: group,
					t: Date.now(),
				});

				peers.push(group);
			}
		} catch (e: any) {
			console.error(e.message || e);
		}
	}

	return peers;
}

async function getUserById(id: number | BigInteger, force?: boolean): Promise<Api.User | undefined> {
	let user = !force && userCache.find((u) => u.u.id.eq(id) && Date.now() - u.t < 1000 * 60 * 60);
	if (!user) {
		let users: Api.User[] | undefined = undefined;

		try {
			users = (await client.invoke(new Api.users.GetUsers({ id: [id] }))) as Api.User[];
		} catch (e: any) {
			console.error('[BOT]', e.message || e);
		}

		if (!users) {
			// maybe we can return a user that has expired if it fails
			return userCache.find((u) => u.u.id.eq(id))?.u;
		}

		user = {
			u: users[0] as Api.User,
			t: Date.now(),
		};

		userCache.push(user);
	}

	return user.u;
}

export default {
	getUsername: () => username,
	getId: () => selfId,
	setup,
	client: () => client,
	sendMessage,
	getGroupPeers,
	getGroupPeer,
	getUserById,
	editMessage,
};
