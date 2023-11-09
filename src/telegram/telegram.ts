import { Api } from 'telegram';
import config from '../config';
import database, { telegramCollection } from '../manager/database';
import { TelegramTicket, TransactionStatus, Vouch, cryptoNames } from '../manager/types';
import { sleep } from '../utils';
import { Account } from './account';
import bot from './bot';
import getText, { Text } from '../texts';
import tickets from './tickets';
import { ActiveTransaction, getTransaction } from '../manager/manager';
import chalk from 'chalk';
import tgutils from './tgutils';
import { captureException, captureMessage } from '@sentry/node';

export const accounts: Account[] = [];
export const activeTickets: TelegramTicket[] = [];

// key is user id, value is last created ticket
const userLimits: { [key: number]: number } = {};

let ticketLock = false;

// startTicket is called when the first user joins the ticket
export async function startTicket(group: Api.Channel, host: Account): Promise<{ message: string; success?: boolean }> {
	let main = host.details.main ? host : getMain();
	if (!main) {
		main = getMain();
		if (!main) {
			return {
				message: 'Failed to find main account',
			};
		}
	}

	host.log(`Starting ticket: ${group.id}`);

	const ticket = activeTickets.find((t) => t.group == group.id.toJSNumber());
	if (!ticket) {
		return {
			message: 'Failed to find ticket',
		};
	}

	// add main account to group
	try {
		const peers: Api.User[] = [];

		if (host != main) {
			const peer = main.getUsername() ? await host.getUserByUsername(main.getUsername() || '') : await host.getUserById(main.getId()?.toJSNumber() || 0);
			if (!peer) {
				// should never happen, need to return failure
				throw new Error('Failed to get main peer');
			}

			peers.push(peer);
		}

		// just for testing, should never happen in production
		// the bot should already be added to the ticket
		if (config.telegram.botToken) {
			const peer = await host.getUserByUsername(bot.getUsername() || '');
			if (!peer) {
				throw new Error('Failed to get bot peer');
			}

			peers.push(peer);
		}

		if (peers.length > 0) {
			await host.client.invoke(
				new Api.channels.InviteToChannel({
					channel: group,
					users: peers,
				})
			);

			host.log(`Added ${peers.length} user${peers.length == 1 ? '' : 's'} to ticket`);

			for (const peer of peers) {
				await host.client.invoke(
					new Api.channels.EditAdmin({
						channel: group,
						userId: peer.id,
						adminRights: new Api.ChatAdminRights({
							changeInfo: true,
							deleteMessages: true,
							banUsers: true,
							inviteUsers: true,
							pinMessages: true,
							addAdmins: true,
							manageCall: true,
							anonymous: true,
							editMessages: true,
							manageTopics: true,
							postMessages: true,
							other: true,
						}),
						rank: peer.bot ? 'The Bot' : 'Admin',
					})
				);
			}
		}
	} catch (e: any) {
		console.error(e.message || e);
		captureException(e);

		return {
			message: 'Failed to add main or bot to group',
		};
	}

	await tickets.setStage(ticket, 'user_wait');
	await tickets.initStage(ticket);

	return {
		message: 'Ticket created successfully',
		success: true,
	};
}

// if userid is a string then it is a username and we need to resolve it
// its preferred to pass in a username because it means all accounts will be able to resolve it
// mainAcc is the preferred account to host the ticket
export async function createTicket(userId: number | string, main?: Account): Promise<{ message: string; link?: boolean }> {
	while (ticketLock) {
		await sleep(100);
	}

	ticketLock = true;

	try {
		// main would be undefined if the user is creating a ticket from the bot
		const hadMain = typeof main != 'undefined';

		if (!main) {
			main = getMain();
			if (!main) {
				return {
					message: 'No telegram accounts are active :(',
				};
			}
		}

		if (await database.isUserBanned(userId, 'telegram')) {
			return {
				message: 'You are banned from creating tickets',
			};
		}

		let uid = typeof userId == 'string' ? (await main.getUserByUsername(userId))?.id.toJSNumber() : userId;
		if (!uid) {
			return {
				message: 'Failed to fetch your user info, please try again later',
			};
		}

		if (Date.now() - userLimits[uid] < 1000 * 60 * 2) {
			return {
				message: 'You are creating tickets too fast, please wait up to 2 minutes before creating another one',
			};
		}

		if (getUnpaidTickets(uid).length >= config.telegram.maxUnpaidTickets) {
			return {
				message: 'You have too many unpaid tickets. Please pay or close one before creating a new one',
			};
		}

		userLimits[uid] = Date.now();

		let group: Api.Channel | undefined;

		// this is the account that owns the group
		let host: Account | undefined = main;
		const possibleHosts = accounts.filter((a) => !a.details.dontUse);

		let currentId = (await telegramCollection.find().sort({ id: -1 }).limit(1).toArray())[0]?.id;
		if (currentId == undefined || typeof currentId != 'number') {
			currentId = 0;
		}

		const ticketId = currentId + 1;

		// cycle through all hosts until it finds one which isnt rate limited
		while (host) {
			try {
				// finds groups that are not hosting a ticket
				const groups = (await host.getDialogs()).filter((d) => {
					if (!d.entity || d.entity.className != 'Channel' || !d.entity.megagroup || !d.entity.creator) {
						return false;
					}

					const cid = d.entity.id.toJSNumber();
					if (activeTickets.some((t) => !t.closed && t.group == cid)) {
						return false;
					}

					return true;
				});

				if (groups.length == 0) {
					group = (await host.createGroup(groupTitle(ticketId))).chat;
				} else {
					group = groups[0].entity as Api.Channel;
				}

				if (group) {
					break;
				}
			} catch (e) {
				console.error(e);
			}

			host = possibleHosts.shift();
		}

		// this occours if all accounts are rate limited
		if (!host) {
			return {
				message: 'There are no available hosting accounts at the moment. Please try again later',
			};
		}

		// idk how this could happen but just in case
		if (!group) {
			return {
				message: 'Failed to create group chat',
			};
		}

		// cleanGroup automatically adds the bot to the ticket
		await cleanGroup(host, group, ticketId);

		// put 10 users just in case they want to add more. create link that expires in 24 hours
		const invite = await host.client.invoke(new Api.messages.ExportChatInvite({ peer: group, usageLimit: 10, expireDate: Math.round(Date.now() / 1000) + 86400 }));
		if (invite.className != 'ChatInviteExported') {
			return {
				message: 'Failed to create invite link',
			};
		}

		const ticket: TelegramTicket = {
			id: ticketId,
			host: host.getId()?.toJSNumber() || -1,
			created: new Date(),
			group: group.id.toJSNumber(),
			invite: invite.link.split('/')[invite.link.split('/').length - 1].replace('+', ''),
			stage: 'waiting',
			user1: {
				id: uid,
			},
		};

		activeTickets.push(ticket);
		await telegramCollection.insertOne(ticket);

		// attempt to automatically add them to group
		/*try {
			const peer = typeof userId == 'string' ? await host.getUserByUsername(userId) : await host.getUserById(userId);
			if (!peer) {
				throw new Error('Failed to find user peer to add to ticket');
			}

			await host.client.invoke(
				new Api.channels.InviteToChannel({
					channel: group,
					users: [peer],
				})
			);

			await tickets.setStage(ticket, 'user_wait');

			const resp = await startTicket(group, host);
			if (!resp.success) {
				host.log(`Failed to start ticket: ${resp.message}`);
				await closeTicket(ticket);
			}

			return {
				message: resp.success ? 'Your ticket was created and you were automatically added to it:\n' + invite.link : resp.message,
			};
		} catch (e: any) {
			host.log(e.message || e);
		}*/

		let sentDM = false;

		// send dm if it wasnt created from the /create main acc command
		if (!hadMain) {
			try {
				const peer = typeof userId == 'string' ? await host.getUserByUsername(userId) : await host.getUserById(userId);
				if (!peer) {
					throw new Error('Failed to find user peer to add to ticket');
				}

				await host.sendMessage(peer, {
					message: getText('telegram/ticketcreate').replace('{link}', invite.link),
				});
				sentDM = true;
			} catch {}
		}

		return {
			message: (sentDM ? 'You were DMed the invite link. The message was sent by @' + host.getUsername() + '\n' : '') + invite.link,
			link: true,
		};
	} catch (e) {
		console.error(e);
	} finally {
		ticketLock = false;
	}

	return {
		message: 'An internal error occurred, please try again later',
	};
}

function getMain() {
	return accounts.find((a) => a.details.main);
}

export async function cleanTicketGroup(ticket: TelegramTicket) {
	const host = accounts.find((a) => a.getId()?.toJSNumber() == ticket.host);
	if (!host) {
		return;
	}

	const group = await host.getGroupById(ticket.group);
	if (!group) {
		host.log(`[CLEANER] Failed to find group for ticket: ${ticket.id}`);
		return;
	}

	// set undefined because this is called when the ticket is closed
	await cleanGroup(host, group, undefined);
}

// run when ticket is made. clears chats, invites, users, etc
export async function cleanGroup(acc: Account, group: Api.Channel, ticketId: number | undefined, tries?: number) {
	try {
		// if no photo upload it W code
		if (group.photo.className == 'ChatPhotoEmpty') {
			try {
				await acc.editGroupPhoto(group, './assets/logo.png');
			} catch {}
		}

		// the title could still contain the old tid so we need to change it
		const customTitle = groupTitle(ticketId);
		if (group.title != customTitle) {
			acc.setGroupTitle(group, customTitle);
		}

		await acc.client.invoke(
			new Api.channels.DeleteHistory({
				channel: group,
				forEveryone: true,
			})
		);

		await revokeInvites(acc, group);

		// remove all users except for the bot
		const users = await acc.client.invoke(
			new Api.channels.GetParticipants({
				channel: group,
				filter: new Api.ChannelParticipantsRecent(),
				offset: 0,
				limit: 100,
			})
		);

		let foundBot = false;

		if (users.className == 'channels.ChannelParticipants') {
			for (const user of users.participants) {
				if (user.className != 'ChannelParticipant') {
					continue;
				}

				if (user.userId.eq(bot.getId() || 0)) {
					foundBot = true;
					continue;
				}

				// remove
				await acc.client.invoke(
					new Api.channels.EditBanned({
						channel: group,
						participant: user.userId,
						// if under 30 seconds then its forever
						bannedRights: new Api.ChatBannedRights({ untilDate: 30, viewMessages: true }),
					})
				);

				acc.log(`Removed user: ${user.userId}`);
			}
		} else {
			acc.log(`Failed to get participants: ${users.className}`);
		}

		if (!foundBot) {
			// add bot
			try {
				const botPeer = await acc.getUserByUsername(bot.getUsername() || '');
				if (botPeer) {
					await acc.client.invoke(
						new Api.channels.InviteToChannel({
							channel: group,
							users: [botPeer],
						})
					);

					acc.log(`Added bot to ticket during cleaning`);
				}
			} catch {}
		}

		// get the removed users list and unadd everyone from the list
		const removed = await acc.client.invoke(
			new Api.channels.GetParticipants({
				channel: group,
				filter: new Api.ChannelParticipantsKicked({ q: '' }),
				offset: 0,
				limit: 100,
			})
		);

		if (removed.className == 'channels.ChannelParticipants') {
			for (const user of removed.participants) {
				if (user.className != 'ChannelParticipantBanned') {
					continue;
				}

				// unban
				await acc.client.invoke(
					new Api.channels.EditBanned({
						channel: group,
						participant: user.peer,
						bannedRights: new Api.ChatBannedRights({ untilDate: Math.round(Date.now() / 1000), viewMessages: false }),
					})
				);

				acc.log(`Unadded user: ${user.peer.className == 'PeerUser' ? user.peer.userId : 'Non-User'}`);
			}
		}
	} catch (e) {
		console.error(e);
		if (tries && tries >= 3) {
			captureMessage(`[Telegram/${acc.getUsername()}] Clean group function timed out: ${group.id.toString()}`);
			return;
		}

		await sleep(1000);
		await cleanGroup(acc, group, ticketId, (tries || 0) + 1);
	}
}

export async function revokeInvites(acc: Account, group: Api.Channel | Api.PeerChannel) {
	const invites = await acc.client.invoke(
		new Api.messages.GetExportedChatInvites({
			peer: group,
			revoked: false,
			adminId: acc.getId(),
			limit: 100,
		})
	);

	for (const invite of invites.invites) {
		if (invite.className != 'ChatInviteExported') {
			continue;
		}

		try {
			await acc.client.invoke(
				new Api.messages.EditExportedChatInvite({
					peer: group,
					link: invite.link,
					revoked: true,
				})
			);

			acc.log(`Revoked invite link: ${invite.link}`);
		} catch (e) {
			console.error(e);
		}
	}

	await acc.client.invoke(
		new Api.messages.DeleteRevokedExportedChatInvites({
			adminId: acc.getId(),
			peer: group,
		})
	);
}

function groupTitle(ticket?: TelegramTicket | number) {
	return getText('telegram/grouptitle').replace('{id}', typeof ticket == 'number' ? ticket.toString() : ticket ? ticket.id.toString() : 'None');
}

export function getUnpaidTickets(uid: number): TelegramTicket[] {
	return activeTickets.filter((t) => !t.closed && (t.user1.id == uid || t.user2?.id == uid) && t.stage != 'ongoing' && t.stage != 'select_address' && t.stage != 'completed');
}

// closes and cleans the ticket
export async function closeTicket(ticket: TelegramTicket, delay?: number) {
	if (ticket.closed || ticket.closing) {
		return;
	}

	if (delay) {
		ticket.closing = true;
		setTimeout(() => {
			delete ticket.closing;
			closeTicket(ticket);
		}, delay);
		return;
	}

	try {
		await cleanTicketGroup(ticket);
	} catch {}

	ticket.closed = true;
	delete ticket.closing;

	ticket.closedAt = new Date();

	await telegramCollection.updateOne({ id: ticket.id }, { $set: { closed: true, closedAt: ticket.closedAt } });

	// remove from active list after updating on database
	activeTickets.splice(activeTickets.indexOf(activeTickets.find((t) => t.id == ticket.id) || ticket), 1);

	if (ticket.tid) {
		try {
			const txn = await getTransaction(ticket.tid);
			if (txn.getStatus() == 'pending') {
				txn.setStatus('cancelled');
			} else {
				console.log(chalk.red(`[${txn.txn.id}] Tried to cancel transaction that was not pending: ${txn.getStatus()}`));
			}
		} catch {}
	}
}

export function hookTransaction(txn: ActiveTransaction) {
	txn.onStatusUpdate(async (old: TransactionStatus, status: TransactionStatus) => {
		const ticket = activeTickets.find((t) => t.tid == txn.txn.id);
		if (!ticket) {
			console.log(chalk.red('[!] Ticket not found for transaction status update'));
			return;
		}

		const host = accounts.find((a) => a.getId()?.toJSNumber() == ticket.host);
		if (!host) {
			console.log(chalk.red('[!] Host not found for transaction status update'));
			return;
		}

		const user1 = await host.getUserById(ticket.user1.id);
		const user2 = ticket.user2 && (await host.getUserById(ticket.user2.id));

		const send = async (textType: Text) => {
			try {
				await bot.sendMessage(ticket.group, {
					message:
						getText(textType)
							.replace('{amount}', txn.getNeededAmount())
							.replace('{crypto}', cryptoNames[txn.getCryptoType()])
							.replace('{addressLink}', txn.getAddressUrl())
							.replace('{txid}', txn.txn.wallet.txid || 'N/A')
							.replace('{sender}', ticket.user1.status == 'sender' ? tgutils.mention(user1) : tgutils.mention(user2))
							.replace('{receiver}', ticket.user1.status == 'receiver' ? tgutils.mention(user1) : tgutils.mention(user2)) || '',
				});
			} catch (e: any) {
				console.error(e.message || e);
				captureException(e);
			}
		};

		switch (status) {
			case 'partial':
				send('telegram/partial');
				break;
			case 'completed':
			case 'refunded':
				{
					const start = Date.now();

					// wait until the txid is set
					while (!txn.txn.wallet.txid && Date.now() - start < 10000) {
						await sleep(100);
					}

					send(status == 'completed' ? 'telegram/completed' : 'telegram/refunded');
				}
				break;
			case 'ongoing':
				send('telegram/ongoing');

				// sends finialize message
				if (ticket.stage == 'pending' && (await tickets.setStage(ticket, 'ongoing'))) {
					await tickets.initStage(ticket);
				}
				break;
		}

		// only send success embed if the funds was successfully sent
		if (
			(ticket.stage == 'ongoing' || ticket.stage == 'pending' || ticket.stage == 'select_address' || ticket.stage == 'completed') &&
			(status == 'completed' || status == 'refunded')
		) {
			await tickets.setStage(ticket, 'completed');
			await tickets.initStage(ticket);
		}
	});
}

export async function sendVouchToTelegram(vouch: Vouch) {
	if (!vouch || !config.telegram.vouchChannel) {
		return;
	}

	const main = accounts.find((a) => a.details.main);
	if (!main) {
		return;
	}

	try {
		const split = config.telegram.vouchChannel.split(':');
		const channel = await main.getGroupById(tgutils.toChatId(split[0]));
		const topicId = split[1] ? parseInt(split[1]) : undefined;

		if (channel) {
			let from = vouch.uid;
			if (vouch.origin == 'telegram') {
				from = tgutils.mention(vouch.uid, 'html');
			}

			await main.client.sendMessage(channel, {
				replyTo: topicId,
				message: `<b><u>${vouch.origin == 'telegram' ? 'Telegram' : vouch.origin == 'discord' ? 'Discord' : 'Other'} Vouch from ${from}</b></u>\n${vouch.msg}`,
				parseMode: 'html',
			});
		}
	} catch (e) {
		main.log(e);
	}
}

(async () => {
	if (!config.telegram.enabled) {
		return;
	}

	activeTickets.push(...(await telegramCollection.find({ closed: { $ne: true } }).toArray()));

	for (const ticket of activeTickets) {
		if (!ticket.tid) {
			continue;
		}

		try {
			hookTransaction(await getTransaction(ticket.tid));
		} catch (e: any) {
			console.error(e.message || e);
			captureException(e);
		}
	}

	await bot.setup();

	for (const acc of config.telegram.accs) {
		const account = new Account(acc);
		try {
			await account.start();
			accounts.push(account);
		} catch (e) {
			console.error(e);
			captureException(e);
		}
	}

	if (accounts.length === 0) {
		console.error('No telegram accounts are active!');
		process.exit();
	}
})();
