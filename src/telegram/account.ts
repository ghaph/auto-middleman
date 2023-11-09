import { Api, TelegramClient } from 'telegram';
import config, { TelegramDetails } from '../config';
import { StringSession } from 'telegram/sessions';
import fs from 'fs';
import { commaNumber, isAllDigits, question } from '../utils';
import { Dialog } from 'telegram/tl/custom/dialog';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { SendMessageParams } from 'telegram/client/messages';
import { accounts, createTicket } from './telegram';
import { Entity } from 'telegram/define';
import getText from '../texts';
import { BigInteger } from 'big-integer';
import database, { bansCollection } from '../manager/database';
import { GroupData } from './types';
import { CustomFile } from 'telegram/client/uploads';
import tickets from './tickets';
import tgutils from './tgutils';
import { captureException } from '@sentry/node';

// 30 minutes
const userCacheDur = 1000 * 60 * 30;

const dialogCacheDur = 1000 * 10;

export class Account {
	details: TelegramDetails;
	client: TelegramClient;

	private sessionPath: string;
	private userCache: {
		u: Api.User;
		t: number;
	}[] = [];

	private dialogCache: Dialog[] = [];
	private lastDialogFetch = 0;

	// key is chat / user id, value is last sent
	private lastMessages: { [key: number]: number } = {};

	private selfId: BigInteger | undefined;
	private username: string | undefined;

	constructor(details: TelegramDetails) {
		this.details = details;
		this.sessionPath = `./sessions/${this.details.name}.session`;

		this.client = new TelegramClient(
			new StringSession(fs.existsSync(this.sessionPath) ? fs.readFileSync(this.sessionPath, 'utf-8') : undefined),
			config.telegram.apiId,
			config.telegram.apiHash,
			{
				connectionRetries: 60000000,
				autoReconnect: true,
			}
		);

		if (!fs.existsSync('./sessions')) {
			fs.mkdirSync('./sessions');
		}
	}

	async start() {
		this.client.setParseMode('html');

		await this.client.start({
			phoneNumber: this.details.phone,
			password: () => question(`[${this.details.name}] Enter password: `),
			phoneCode: () => question(`[${this.details.name}] Enter login code: `),
			onError: async (e) => {
				console.log(e);
				captureException(e);
				return false;
			},
		});

		fs.writeFileSync(this.sessionPath, (this.client.session.save() as any).toString());

		const me = (await this.client.getMe()) as Api.User;
		this.selfId = me.id;
		this.username = me.username || (me.usernames && me.usernames.length > 0 ? me.usernames[0].username : undefined);

		this.log(`Logged in as @${this.username} (${this.selfId})`);

		const atx = this;

		this.client.addEventHandler(async (event: NewMessageEvent) => {
			try {
				await onMessage(atx, event);
			} catch (e) {
				console.error(e);
				captureException(e);
			}
		}, new NewMessage({}));

		// just incase auto reconnect fails
		let lastConnected = Date.now();
		setInterval(() => {
			if (atx.client.connected) {
				lastConnected = Date.now();
				return;
			}

			if (!atx.client.connected && Date.now() - lastConnected > 10000) {
				atx.log('Reconnecting due to no connection for 10 seconds');
				atx.client.connect();
			}
		}, 1000);
	}

	async removeMembers(group: Api.Channel | Api.PeerChannel, filter: (user: BigInteger) => boolean): Promise<number> {
		const users = await this.client.invoke(
			new Api.channels.GetParticipants({
				channel: group,
				filter: new Api.ChannelParticipantsRecent(),
				offset: 0,
				limit: 100,
			})
		);

		let removed = 0;

		if (users.className == 'channels.ChannelParticipants') {
			for (const user of users.participants) {
				if (user.className != 'ChannelParticipant' || filter(user.userId)) {
					continue;
				}

				// remove
				try {
					await this.client.invoke(
						new Api.channels.EditBanned({
							channel: group,
							participant: user.userId,
							// if under 30 seconds then its forever
							bannedRights: new Api.ChatBannedRights({ untilDate: 30, viewMessages: true }),
						})
					);

					removed++;
					this.log(`Removed user: ${user.userId}`);
				} catch {
					this.log(`Failed to remove user: ${user.userId}`);
				}
			}
		} else {
			this.log(`Failed to get participants: ${users.className}`);
		}

		return removed;
	}

	async editGroupPhoto(group: Api.Channel, path: string) {
		if (!fs.existsSync(path)) {
			console.error(`[Edit Group Photo] File does not exist: ${path}`);
			return;
		}

		const extension = path.split('.').pop();
		const read = fs.readFileSync(path);

		const file = await this.client.uploadFile({
			file: new CustomFile('photo.' + extension, read.length, '', read),
			workers: 1,
		});

		const photo = new Api.InputChatUploadedPhoto({ file });

		await this.client.invoke(
			new Api.channels.EditPhoto({
				channel: group,
				photo: photo,
			})
		);

		// prevent editGroupPhoto from being called again
		group.photo.className = 'ChatPhoto';
	}

	async createGroup(title: string): Promise<GroupData> {
		const result = await this.client.invoke(new Api.channels.CreateChannel({ title, broadcast: true, megagroup: true, about: config.telegram.groupDescription }));
		const comb = result as unknown as Api.UpdatesCombined;
		return {
			chat: comb.chats[0] as Api.Channel,
			users: comb.users as Api.User[],
		};
	}

	async getUserByUsername(username: string): Promise<Api.User | undefined> {
		const cached = this.userCache.find((u) => (u.u.username && u.u.username == username) || (u.u.usernames && u.u.usernames?.some((un) => un.username == username)));
		if (cached && Date.now() - cached.t < userCacheDur) {
			return cached.u;
		}

		const users = (await this.client.invoke(new Api.contacts.ResolveUsername({ username: username }))).users.filter((u) => u.className == 'User') as Api.User[];
		if (!users) {
			// try to return the expired cached user
			return cached?.u;
		}

		for (const user of users) {
			if (!(user instanceof Api.User)) {
				continue;
			}

			const found = this.userCache.find((u) => u.u.id.eq(user.id));
			if (!found) {
				this.userCache.push({
					u: user as Api.User,
					t: Date.now(),
				});
			} else {
				const ind = this.userCache.indexOf(found);
				this.userCache[ind] = {
					u: user as Api.User,
					t: Date.now(),
				};
			}
		}

		return users.find((u) => u.username == username || u.usernames?.some((un) => un.username == username));
	}

	async getUserById(id: number | BigInteger): Promise<Api.User | undefined> {
		if (this.lastDialogFetch == 0) {
			await this.getDialogs();
		}

		const cached = this.userCache.find((u) => u.u.id.eq(id));
		if (cached) {
			return cached.u;
		}

		let users: Api.User[] | undefined = undefined;
		try {
			users = (await this.client.invoke(new Api.users.GetUsers({ id: [Number(id)] }))) as Api.User[];
		} catch (e: any) {
			console.error(e.message || e);
		}

		if (!users) {
			return undefined;
		}

		for (const user of users) {
			const found = this.userCache.find((u) => u.u.id.eq(user.id));
			if (!found) {
				this.userCache.push({
					u: user as Api.User,
					t: Date.now(),
				});
			} else {
				const ind = this.userCache.indexOf(found);
				this.userCache[ind] = {
					u: user as Api.User,
					t: Date.now(),
				};
			}
		}

		return users.find((u) => u.id.eq(id));
	}

	async getGroupById(id: number | BigInteger, force?: boolean): Promise<Api.Channel | undefined> {
		if (!force) {
			const cached = this.dialogCache.find((d) => d.entity && d.id?.eq(id))?.entity as Api.Channel | undefined;
			if (cached) {
				return cached;
			}
		}

		try {
			const groups = await this.client.invoke(new Api.channels.GetChannels({ id: [tgutils.toChatId(id)] }));
			if (!groups) {
				return undefined;
			}

			const group = groups.chats.find((c) => c.className == 'Channel' && c.id?.eq(id)) as Api.Channel | undefined;
			if (group) {
				this.dialogCache.push({
					entity: group,
					id: group.id,
				} as any);
			}

			return group;
		} catch (e) {
			console.error(e);
			captureException(e);
		}

		return undefined;
	}

	async getDialogs() {
		if (Date.now() - this.lastDialogFetch < dialogCacheDur) {
			return this.dialogCache;
		}

		this.dialogCache = await this.client.getDialogs();
		this.lastDialogFetch = Date.now();

		return this.dialogCache;
	}

	// rate limit (in ms) makes sure that the message doesnt get spammed in the chat
	async sendMessage(chat: Entity | number | undefined, message: SendMessageParams, rateLimit?: number) {
		const chatId = typeof chat == 'number' ? chat : chat?.id.toJSNumber();
		if (!chat || !chatId || (rateLimit && Date.now() - this.lastMessages[chatId] < rateLimit)) {
			return;
		}

		this.lastMessages[chatId] = Date.now();

		if (typeof chat == 'number') {
			// use cache / add to cache
			const cached = await this.getGroupById(chat);
			if (cached) {
				chat = cached;
			}
		}

		await this.client.sendMessage(chat, message);
	}

	// do this async as its really easy to get rate limited
	setGroupTitle(chat: Api.Channel, title: string) {
		if (chat.title != title) {
			chat.title = title;
			this.client.invoke(new Api.channels.EditTitle({ channel: chat, title: title })).catch((e) => {
				console.error(e);
			});
		}
	}

	getUsername() {
		return this.username;
	}

	getId() {
		return this.selfId;
	}

	log(msg: any) {
		console.log(`[${this.details.name}]`, msg);
	}
}

async function onMessage(acc: Account, event: NewMessageEvent) {
	const message = event.message;
	if (event.isGroup) {
		// if the host and the main are the same, we only want to listen to the main
		if (acc.details.main) {
			try {
				await tickets.onMessage(acc, event);
			} catch (e) {
				console.error(e);
				captureException(e);
			}
		}
		return;
	}

	const from = message.fromId || message.peerId;
	if (from.className != 'PeerUser') {
		return;
	}

	const fromId = from.userId.toJSNumber();
	if (acc.getId()?.eq(fromId)) {
		return;
	}

	const fromUser = await acc.getUserById(fromId);
	if (!fromUser || fromUser.bot) {
		return;
	}

	const chat = event.chat || fromUser;

	// create commands can only be responded to main
	if (!acc.details.main) {
		const mainAcc = accounts.find((a) => a.details.main);

		// send rate limited message
		await acc.sendMessage(
			chat,
			{
				message: "I don't respond to DMs. You can create a ticket in t.me/" + getText('telegram') + (mainAcc ? ' or dm @' + mainAcc.getUsername() : ''),
				replyTo: message,
			},
			5000
		);
		return;
	}

	// put multiple possible prefixes to let them know the real prefix
	if (!message.message.startsWith('/') && !message.message.startsWith('!') && !message.message.startsWith('.') && !message.message.startsWith('-')) {
		return;
	}

	const split = message.message.split(' ');

	switch (split[0].toLowerCase()) {
		case '/create':
			{
				// prefer username because other hosts can access the user, instead of user id which other hosts cannot access
				const resp = await createTicket(tgutils.getUsername(fromUser) || fromId, acc);

				if (resp.link) {
					await acc.sendMessage(chat, {
						message: getText('telegram/ticketcreate').replace('{link}', resp.message),
					});
				} else {
					await acc.sendMessage(
						chat,
						{
							message: resp.message,
							replyTo: message,
						},
						500
					);
				}
			}
			break;
		case '/stats':
			{
				const userData = await database.getUserStats(fromId.toString(), 'telegram');
				if (!userData) {
					await acc.sendMessage(
						chat,
						{
							message: "You don't have any stats",
							replyTo: message,
						},
						500
					);
					break;
				}

				const stats = userData.stats || {};
				await acc.sendMessage(
					chat,
					{
						message: `<b>Stats for ${tgutils.mention(fromUser)}\nUID:</b> ${userData.id}\n<b>Total Deals:</b> ${commaNumber(
							stats.mms || 0
						)}\n<b>Total Sent:</b> $${commaNumber(stats.sent || 0)}\n<b>Total Received:</b> $${commaNumber(stats.received || 0)}\n<b>Total Volume:</b> $${(
							parseFloat(stats.received || '0') + parseFloat(stats.sent || '0')
						).toFixed(2)}\n<b>Balance:</b> $${commaNumber(stats.balance || 0)}`,
						parseMode: 'html',
					},
					100
				);
			}
			break;
		case '/help':
			await acc.sendMessage(
				chat,
				{
					message: getText('telegram/dmhelp'),
				},
				500
			);
			break;
		case '/link':
			await acc.sendMessage(
				chat,
				{
					message: 'This feature is not ready yet',
					replyTo: message,
				},
				500
			);
			break;
		case '/ban':
			if (!tgutils.isStaff(fromUser)) {
				break;
			}

			if (split.length < 2 || !isAllDigits(split[1])) {
				await acc.sendMessage(
					chat,
					{
						message: '<b>USAGE:</b> /ban [user id] [reason]',
						replyTo: message,
					},
					500
				);
				break;
			}

			const userId = split[1];
			if (await database.isUserBanned(userId, 'telegram')) {
				await acc.sendMessage(
					chat,
					{
						message: 'User is already banned',
						replyTo: message,
					},
					500
				);
				break;
			}

			const reason = split.slice(2).join(' ');

			try {
				await bansCollection.insertOne({
					id: userId,
					date: new Date(),
					origin: 'telegram',
					reason,
				});

				await acc.sendMessage(chat, {
					message: 'Successfully banned user',
					replyTo: message,
				});
			} catch (e) {
				console.error(e);
				captureException(e);
				await acc.sendMessage(
					chat,
					{
						message: 'Failed to ban user.',
						replyTo: message,
					},
					500
				);
			}
			break;
		default:
			await acc.sendMessage(
				chat,
				{
					message: 'That is not a recognized command. Please type /help for a full list of commands',
					replyTo: message,
				},
				2500
			);
			break;
	}
}
