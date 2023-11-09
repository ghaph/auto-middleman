import { NewMessageEvent } from 'telegram/events';
import { Account } from './account';
import { CryptoType, TelegramMessage, TelegramStage, TelegramTicket, cryptoNames } from '../manager/types';
import database, { telegramCollection } from '../manager/database';
import { accounts, activeTickets, closeTicket, hookTransaction, revokeInvites } from './telegram';
import bot from './bot';
import tgutils from './tgutils';
import { Api } from 'telegram';
import { MatchKeysAndValues } from 'mongodb';
import config from '../config';
import { isValidAddress } from '../utils';
import ticketStages from './ticketstages';
import { createTransaction, getTransaction } from '../manager/manager';
import { BigInteger } from 'big-integer';
import getText from '../texts';
import { captureException } from '@sentry/node';

// acc is always going to be a main acc
async function onMessage(acc: Account, event: NewMessageEvent) {
	const message = event.message;
	if (!message.text || !message.fromId || message.fromId.className != 'PeerUser' || message.peerId.className != 'PeerChannel') {
		return;
	}

	const ticket = activeTickets.find((t) => !t.closed && !t.closing && message.chat?.id.eq(t.group));
	if (!ticket) {
		return;
	}

	const from = await acc.getUserById(message.fromId.userId);
	if (!from) {
		acc.log('[Ticket Message] Failed to get user: ' + message.fromId.userId);
		return;
	}

	const fromName = tgutils.getName(from);
	if (from.id.eq(ticket.user1.id) && ticket.user1.name != fromName) {
		ticket.user1.name = fromName;
		await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1 } });
	} else if (ticket.user2 && from.id.eq(ticket.user2.id) && ticket.user2.name != fromName) {
		ticket.user2.name = fromName;
		await telegramCollection.updateOne({ id: ticket.id }, { $set: { user2: ticket.user2 } });
	}

	if (!ticket.messages) {
		ticket.messages = {};
	}

	const idStr = message.id.toString();
	if (!ticket.messages[idStr]) {
		const obj: TelegramMessage = {
			ct: message.text,
			at: from.id.toJSNumber(),
		};

		if (from.bot) {
			obj.bot = true;
		}

		ticket.messages[idStr] = obj;

		const set: MatchKeysAndValues<TelegramTicket> = {};
		set['messages.' + idStr] = obj;

		telegramCollection.updateOne({ id: ticket.id }, { $set: set }).catch((e) => {
			console.error(e);
			captureException(e);
		});
	}

	// ignore all messages that are from bots / people who arent in ticket
	if (from.bot || (!tgutils.isStaff(from) && !from.id.eq(ticket.user1.id) && (!ticket.user2 || !from.id.eq(ticket.user2.id)))) {
		return;
	}

	// mark message as read
	//acc.client.markAsRead(message.peerId).catch((e) => console.error(e));

	// ticket commands
	if (message.text.startsWith('/')) {
		// returns true if the switch should be breaked
		const checkStaff = async () => {
			if (!tgutils.isStaff(from)) {
				await bot.sendMessage(
					ticket.group,
					{
						message: 'You are not allowed to use this command',
						replyTo: message.id,
					},
					1000
				);
				return true;
			}

			return false;
		};

		const args = message.text.split(' ');
		switch (args[0]) {
			case '/forcesend':
				if (!ticket.tid || !acc.getId()?.eq(from.id) || !acc.details.main) {
					break;
				}

				if (!['complete', 'completed', 'refund', 'refunded'].includes(args[1]) || args[2]?.length <= 20) {
					await bot.sendMessage(ticket.group, {
						message: '<b>USAGE:</b> /forcesend <complete/refund> <address>',
						parseMode: 'html',
					});
					break;
				}

				const status: 'completed' | 'refunded' = args[1] == 'complete' || args[1] == 'completed' ? 'completed' : 'refunded';

				const txn = await getTransaction(ticket.tid);
				await bot.sendMessage(ticket.group, {
					message: await txn.finalize(args[2], status, true),
				});
				break;
			case '/staff':
				if (ticket.staff && !tgutils.isStaff(from)) {
					await bot.sendMessage(
						ticket.group,
						{
							message: 'Staff have already been called to this ticket',
							replyTo: message.id,
						},
						2000
					);
					break;
				}

				if (ticket.stage != 'completed' && ticket.stage != 'ongoing' && ticket.stage != 'pending' && ticket.stage != 'select_address') {
					await bot.sendMessage(
						ticket.group,
						{
							message: 'You cannot call staff members at this stage of the ticket',
							replyTo: message.id,
						},
						2000
					);
					break;
				}

				if (!ticket.staff) {
					ticket.staff = true;
					await telegramCollection.updateOne({ id: ticket.id }, { $set: { staff: ticket.staff } });
				}

				const peers: Api.User[] = [];

				for (const staff of config.telegram.staff) {
					let user = typeof staff == 'string' ? await acc.getUserByUsername(staff) : await acc.getUserById(staff);
					if (!user) {
						acc.log('Failed to add staff user: ' + staff);
						continue;
					}

					peers.push(user);
				}

				if (peers.length > 0) {
					let added = 0;
					let invite: Api.TypeExportedChatInvite | undefined;

					for (const peer of peers) {
						try {
							await acc.client.invoke(
								new Api.channels.InviteToChannel({
									channel: message.peerId,
									users: peers,
								})
							);

							added++;
						} catch {
							acc.log('Failed to add staff user: ' + peer.id);
							try {
								if (!invite) {
									invite = await acc.client.invoke(
										new Api.messages.ExportChatInvite({
											peer: message.peerId,
										})
									);
								}

								if (invite && invite.className == 'ChatInviteExported') {
									await acc.sendMessage(peer, {
										message: 'Staff members were requested in the ticket below\n\n' + invite.link,
									});

									added++;
								}
							} catch {
								acc.log('Failed to send message to staff user: ' + peer.id);
							}
						}
					}

					await bot.sendMessage(ticket.group, {
						message: `Added/notified ${added} staff member${added == 1 ? '' : 's'}`,
						replyTo: message.id,
					});
				} else {
					await bot.sendMessage(ticket.group, {
						message: 'No staff users found',
						replyTo: message.id,
					});
				}

				break;
			case '/kick':
				{
					if (ticket.user1.kick && ticket.user2?.kick) {
						break;
					}

					let voted = false;

					if (from.id.eq(ticket.user1.id)) {
						ticket.user1.kick = !ticket.user1.kick;
						voted = ticket.user1.kick;
					} else if (ticket.user2 && from.id.eq(ticket.user2.id)) {
						ticket.user2.kick = !ticket.user2.kick;
						voted = ticket.user2.kick;
					} else {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'You are not part of this ticket',
								replyTo: message.id,
							},
							1000
						);
						break;
					}

					await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1, user2: ticket.user2 } });

					if (voted) {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'You voted to kick all extra users',
								replyTo: message.id,
							},
							1000
						);
					} else {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'You removed your vote to kick all extra users',
								replyTo: message.id,
							},
							1000
						);
					}

					if (ticket.user1.kick && ticket.user2?.kick) {
						try {
							await revokeInvites(acc, message.peerId);
						} catch (e) {
							console.error(e);
						}

						// remove all users except for the bot
						const count = await acc.removeMembers(
							message.peerId,
							(id) => id.eq(bot.getId() || 0) || id.eq(ticket.user1.id) || (ticket.user2 && id.eq(ticket.user2.id)) || tgutils.isStaff(id.toJSNumber())
						);

						await bot.sendMessage(ticket.group, {
							message: 'Successfully removed ' + count + ' user' + (count == 1 ? '' : 's'),
							replyTo: message.id,
						});
					}
				}
				break;
			case '/close':
				{
					if (ticket.stage == 'ongoing' || ticket.stage == 'select_address') {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'You cannot close the ticket while it is ongoing',
								replyTo: message.id,
							},
							1000
						);
						break;
					}

					if (ticket.closed || ticket.closing) {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'Ticket is already closing',
								replyTo: message.id,
							},
							1000
						);
					}

					let voted = false;

					if (from.id.eq(ticket.user1.id)) {
						ticket.user1.close = !ticket.user1.close;
						voted = ticket.user1.close;
					} else if (ticket.user2 && from.id.eq(ticket.user2.id)) {
						ticket.user2.close = !ticket.user2.close;
						voted = ticket.user2.close;
					} else {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'You are not part of this ticket',
								replyTo: message.id,
							},
							1000
						);
						break;
					}

					await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1, user2: ticket.user2 } });

					if (ticket.user1.close && (!ticket.user2 || ticket.user2.close)) {
						await bot.sendMessage(ticket.group, {
							message: 'This ticket will close in 5 seconds',
							replyTo: message.id,
						});

						await closeTicket(ticket, 5000);
						break;
					}

					if (voted) {
						await bot.sendMessage(
							ticket.group,
							{
								message: 'You voted to close the ticket',
								replyTo: message.id,
							},
							1000
						);
						break;
					}
					await bot.sendMessage(
						ticket.group,
						{
							message: 'You removed your vote to close the ticket',
							replyTo: message.id,
						},
						1000
					);
				}
				break;
			case '/initstage':
				if (await checkStaff()) {
					break;
				}

				await ticketStages.init(ticket);
				break;
			case '/forwardvouch':
				if (await checkStaff()) {
					break;
				}

				const msg = await message.getReplyMessage();
				if (!msg || !msg.fromId || msg.fromId.className != 'PeerUser') {
					await bot.sendMessage(
						ticket.group,
						{
							message: 'You must reply to a message',
							replyTo: message.id,
						},
						1000
					);
					break;
				}

				await forwardVouch(ticket, msg, msg.fromId.userId);
				break;
		}
		return;
	}

	switch (ticket.stage) {
		case 'completed':
			if (!message.text.toLowerCase().startsWith('+vouch ') && !message.text.toLowerCase().startsWith('+rep ') && !message.text.toLowerCase().startsWith('vouch ')) {
				break;
			}

			const main = accounts.find((a) => a.details.main);
			if (!main) {
				break;
			}

			const target = message.text.split(' ')[1]?.toLowerCase();

			// if they arent vouching the main acc or the bot account or the channel then ignore
			if (
				target &&
				target != '@' + main?.getUsername()?.toLowerCase() &&
				target != '@' + bot.getUsername()?.toLowerCase() &&
				target != 't.me/' + getText('telegram').toLowerCase() &&
				target != '@' + getText('telegram').toLowerCase()
			) {
				break;
			}

			if (await database.isUserBanned(from.id.toString(), 'telegram')) {
				await bot.sendMessage(
					ticket.group,
					{
						message: 'You are forbidden from vouching.',
					},
					3000
				);
				break;
			}

			await forwardVouch(ticket, message, from.id);
			break;
		case 'select_address':
			if (!ticket.result || !from.id.eq(ticket.result) || typeof ticket.tid != 'number' || !ticket.status) {
				break;
			}

			const address = message.text.trim();
			if (!isValidAddress(address)) {
				await bot.sendMessage(
					ticket.group,
					{
						message: 'Invalid address',
						replyTo: message.id,
					},
					1000
				);
				break;
			}

			try {
				const txn = await getTransaction(ticket.tid);
				if (!txn) {
					await bot.sendMessage(
						ticket.group,
						{
							message: 'Failed to retrieve transaction',
							replyTo: message.id,
						},
						1000
					);
					break;
				}

				if (ticket.stage != 'select_address' || !(await setStage(ticket, 'completed'))) {
					break;
				}

				await bot.sendMessage(ticket.group, {
					message: await txn.finalize(address, ticket.status == 'complete' ? 'completed' : 'refunded'),
					replyTo: message.id,
				});
			} catch (e) {
				console.error(e);
				captureException(e);

				await bot.sendMessage(ticket.group, {
					message: 'Failed to send transaction',
					replyTo: message.id,
				});
			}
			break;
		case 'select_value':
			{
				let value = 0;
				try {
					value = parseFloat(message.text.trim().replace(/\$|\,/g, ''));
				} catch {}

				if (!value || value <= 0) {
					break;
				}

				const minAmount = config.crypto.overrides[ticket.user1.crypto || ticket.user2?.crypto || 'btc']?.minAmount || config.crypto.minAmount;
				if (value < minAmount) {
					try {
						await bot.sendMessage(
							ticket.group,
							{
								message: `Your amount is under the minimum threshold of <b>$${minAmount}</b>`,
							},
							1000
						);
					} catch {}
					break;
				}

				const str = value.toFixed(2);

				if (from.id.eq(ticket.user1.id)) {
					ticket.user1.value = str;
				} else if (ticket.user2 && from.id.eq(ticket.user2.id)) {
					ticket.user2.value = str;
				} else {
					break;
				}

				if (await setStage(ticket, 'accept_value', true)) {
					await ticketStages.init(ticket);
					await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1, user2: ticket.user2, stage: ticket.stage } });
				}
			}
			break;
		case 'define':
			if (await setStage(ticket, 'votecrypto')) {
				await ticketStages.init(ticket);
			}
			break;
	}
}

async function onCallback(event: Api.UpdateBotCallbackQuery) {
	const customId = event.data?.toString('utf-8');
	if (!customId || event.peer.className != 'PeerChannel') {
		return;
	}

	const split = customId.split(':');

	const ticket = activeTickets.find((t) => !t.closed && !t.closing && t.id == parseInt(split[1]));
	if (!ticket) {
		return;
	}

	const args = split.slice(2);

	const botUser1 = await bot.getUserById(ticket.user1.id);
	const botUser2 = ticket.user2 ? await bot.getUserById(ticket.user2.id) : undefined;

	let response: string | undefined = undefined;
	let alert: boolean = false;

	switch (split[0]) {
		case 'finalize':
			if (ticket.stage != 'ongoing') {
				response = 'Ticket is not ongoing';
				break;
			}

			if (args[0] != 'refund' && args[0] != 'complete' && args[0] != 'clear') {
				response = 'Invalid response';
				break;
			}

			const set: 'complete' | 'refund' | 'clear' = args[0];
			response = 'You voted to ' + set + ' the ticket';

			if (event.userId.eq(ticket.user1.id)) {
				if (set == ticket.user1.vote) {
					break;
				}

				if (set == 'clear') {
					delete ticket.user1.vote;
				} else {
					ticket.user1.vote = set;
				}
			} else if (ticket.user2 && event.userId.eq(ticket.user2.id)) {
				if (set == ticket.user2.vote) {
					break;
				}

				if (set == 'clear') {
					delete ticket.user2.vote;
				} else {
					ticket.user2.vote = set;
				}
			}

			if (ticket.user1.vote && ticket.user2?.vote && ticket.user1.vote == ticket.user2.vote) {
				if (ticket.user1.vote === 'complete') {
					ticket.result = ticket.user1.status === 'receiver' ? ticket.user1.id : ticket.user2.id;
				} else if (ticket.user1.vote === 'refund') {
					ticket.result = ticket.user1.status === 'sender' ? ticket.user1.id : ticket.user2.id;
				} else {
					ticket.result = undefined;
				}

				if (ticket.result && (await setStage(ticket, 'select_address', true))) {
					ticket.status = ticket.user1.vote;

					await ticketStages.init(ticket);
				}
			}

			await telegramCollection.updateOne(
				{ id: ticket.id },
				{ $set: { user1: ticket.user1, user2: ticket.user2, stage: ticket.stage, result: ticket.result, status: ticket.status } }
			);

			try {
				const resp = ticketStages.buildFinalize(ticket, tgutils.mention(botUser1), tgutils.mention(botUser2));

				await bot.editMessage(event.peer, {
					message: event.msgId,
					text: resp.message,
					buttons: resp.buttons,
				});
			} catch (e) {
				console.error(e);
				captureException(e);
			}
			break;
		case 'acceptvalue':
			{
				if (ticket.stage != 'accept_value') {
					response = 'A value has already been accepted';
					break;
				}

				if (args[0] != 'accept' && args[0] != 'reject') {
					response = 'Invalid response';
					break;
				}

				const accept = args[0] == 'accept';

				if (accept) {
					// if the user voting has already accepted the value, then ignore
					if ((event.userId.eq(ticket.user1.id) && ticket.user1.value) || (ticket.user2 && event.userId.eq(ticket.user2.id) && ticket.user2.value)) {
						response = 'You already accepted the value';
					} else {
						if (event.userId.eq(ticket.user1.id)) {
							ticket.user1.value = ticket.user2?.value;
						} else if (ticket.user2 && event.userId.eq(ticket.user2.id)) {
							ticket.user2.value = ticket.user1.value;
						} else {
							response = 'You are not part of this ticket';
							break;
						}

						response = 'You accepted the value';
					}

					if (ticket.user1.value && ticket.user2?.value && ticket.user1.value == ticket.user2.value) {
						ticket.stage = 'pending';

						try {
							const txn = await createTransaction(
								ticket.user1.value || ticket.user2?.value,
								ticket.user1.crypto || ticket.user2?.crypto || 'btc',
								{
									sender: (ticket.user1.status == 'sender' ? ticket.user1.id : ticket.user2!.id).toString(),
									receiver: (ticket.user1.status == 'receiver' ? ticket.user1.id : ticket.user2!.id).toString(),
								},
								'telegram'
							);

							hookTransaction(txn);

							ticket.tid = txn.txn.id;
							await ticketStages.init(ticket);
						} catch (e) {
							console.error(e);
							captureException(e);
							ticket.stage = 'accept_value';
							response = 'There was an error creating the transaction. Please try again later';
						}

						await setStage(ticket, ticket.stage, true);
						await telegramCollection.updateOne({ id: ticket.id }, { $set: { stage: ticket.stage, tid: ticket.tid, user1: ticket.user1, user2: ticket.user2 } });
					}
					break;
				}

				delete ticket.user1.value;
				delete ticket.user2?.value;

				response = 'You rejected the value';

				if (await setStage(ticket, 'select_value', true)) {
					await ticketStages.init(ticket);

					// put after setStage in order to set the stage before just in case this is delayed
					await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1, user2: ticket.user2, stage: ticket.stage } });
				}

				await bot.client().deleteMessages(event.peer, [event.msgId], {
					revoke: true,
				});
			}
			break;
		case 'selectstatus':
			{
				if (ticket.stage != 'select_status') {
					response = "You've already selected your status";
					break;
				}

				const status = args[0] as 'sender' | 'receiver' | 'clear';
				if (status != 'sender' && status != 'receiver' && status != 'clear') {
					response = 'Invalid status type';
					break;
				}

				if (!event.userId.eq(ticket.user1.id) && (!ticket.user2 || !event.userId.eq(ticket.user2.id))) {
					response = 'You are not part of this ticket';
					break;
				}

				if (status == 'clear') {
					if (event.userId.eq(ticket.user1.id)) {
						delete ticket.user1.status;
					} else if (ticket.user2 && event.userId.eq(ticket.user2.id)) {
						delete ticket.user2.status;
					}

					response = 'You cleared your status';
				} else if (event.userId.eq(ticket.user1.id)) {
					if (status == ticket.user1.status) {
						response = 'You already selected this status';
					} else {
						response = 'You selected ' + status;
						ticket.user1.status = status;
					}

					// overwrite the status if both users have the same status
					if (ticket.user2 && ticket.user1.status == ticket.user2.status) {
						delete ticket.user2.status;
					}
				} else if (ticket.user2 && event.userId.eq(ticket.user2.id)) {
					if (status == ticket.user2.status) {
						response = 'You already selected this status';
					} else {
						response = 'You selected ' + status;
						ticket.user2.status = status;
					}

					// overwrite the status if both users have the same status
					if (ticket.user1.status == ticket.user2.status) {
						delete ticket.user1.status;
					}
				}

				if (ticket.user1.status && ticket.user2?.status && ticket.user2?.status != ticket.user1?.status && (await setStage(ticket, 'select_value', true))) {
					await ticketStages.init(ticket);

					// put after in order to set the stage before just in case this is delayed
					await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1, user2: ticket.user2, stage: ticket.stage } });
				}

				const built = ticketStages.buildSelectStatus(ticket, tgutils.mention(botUser1), tgutils.mention(botUser2));
				try {
					await bot.editMessage(event.peer, {
						message: event.msgId,
						text: built.message,
						buttons: built.buttons,
					});
					// catch when message not modified error
				} catch {}
			}
			break;

		case 'selectcrypto':
			{
				if (ticket.stage != 'votecrypto') {
					response = "You've already voted for the crypto";
					break;
				}

				const crypto = args[0] as CryptoType | 'clear';
				if (crypto != 'clear' && !cryptoNames[crypto]) {
					response = 'Invalid crypto type';
					break;
				}

				if (crypto == 'clear') {
					if (event.userId.eq(ticket.user1.id)) {
						delete ticket.user1.crypto;
					} else if (ticket.user2 && event.userId.eq(ticket.user2.id)) {
						delete ticket.user2.crypto;
					} else {
						response = 'You are not part of this ticket';
						break;
					}
				} else {
					if (event.userId.eq(ticket.user1.id)) {
						if (crypto == ticket.user1.crypto) {
							response = 'You already selected this crypto';
						} else {
							response = 'You selected ' + cryptoNames[crypto];
							ticket.user1.crypto = crypto;
						}
					} else if (ticket.user2 && event.userId.eq(ticket.user2.id)) {
						if (crypto == ticket.user2.crypto) {
							response = 'You already selected this crypto';
						} else {
							response = 'You selected ' + cryptoNames[crypto];
							ticket.user2.crypto = crypto;
						}
					} else {
						response = 'You are not part of this ticket';
						break;
					}
				}

				if (ticket.user1.crypto === ticket.user2?.crypto && (await setStage(ticket, 'select_status', true))) {
					await ticketStages.init(ticket);

					await telegramCollection.updateOne({ id: ticket.id }, { $set: { user1: ticket.user1, user2: ticket.user2, stage: ticket.stage } });
				}

				const built = ticketStages.buildVoteCrypto(ticket, tgutils.mention(botUser1), tgutils.mention(botUser2));
				try {
					await bot.editMessage(event.peer, {
						message: event.msgId,
						text: built.message,
						buttons: built.buttons,
					});
					// catch when message not modified error
				} catch {}
			}

			break;
	}

	if (response) {
		await bot.client().invoke(
			new Api.messages.SetBotCallbackAnswer({
				queryId: event.queryId,
				message: response,
				alert: alert,
			})
		);
	}
}

async function setStage(ticket: TelegramTicket, stage: TelegramStage, dontUpdate?: boolean): Promise<boolean> {
	if (ticket.stage == stage) {
		return false;
	}

	console.log(`[Telegram/${ticket.id}] Set Stage: ${ticket.stage} -> ${stage}`);

	ticket.stage = stage;
	ticket.updated = new Date();

	if (!dontUpdate) {
		await telegramCollection.updateOne({ id: ticket.id }, { $set: { stage, updated: ticket.updated } });
	}
	return true;
}

async function forwardVouch(ticket: TelegramTicket, message: Api.Message, fromId: BigInteger) {
	// only works if the user is apart of the ticket
	if (!fromId.eq(ticket.user1.id) && (!ticket.user2 || !fromId.eq(ticket.user2.id))) {
		return;
	}

	const main = accounts.find((a) => a.details.main);
	if (!main) {
		return;
	}

	if (!config.telegram.vouchChannel || typeof config.telegram.vouchChannel != 'string') {
		await bot.sendMessage(
			ticket.group,
			{
				message: "Vouches haven't been setup. Please let a staff member know",
				replyTo: message.id,
			},
			1500
		);
		return;
	}

	const vouch = await database.createVouch({
		uid: fromId.toString(),
		date: new Date(),
		msg: message.text,
		origin: 'telegram',
	});

	if (vouch) {
		try {
			const split = config.telegram.vouchChannel.toString().split(':');
			const channel = await main.getGroupById(tgutils.toChatId(split[0]));
			const topicId = split[1] ? parseInt(split[1]) : undefined;

			if (channel) {
				await main.client.invoke(
					new Api.messages.ForwardMessages({
						id: [message.id],
						fromPeer: message.peerId,
						toPeer: channel,
						silent: true,
						withMyScore: true,
						topMsgId: topicId,
					})
				);
			}

			await bot.sendMessage(ticket.group, {
				message: 'Thanks for the vouch',
				replyTo: message.id,
			});
		} catch (e) {
			main.log(e);

			await bot.sendMessage(ticket.group, {
				message: 'Failed to send vouch',
				replyTo: message.id,
			});
		}
		return;
	}

	await bot.sendMessage(
		ticket.group,
		{
			message: "You've already vouched too recently",
			replyTo: message.id,
		},
		1500
	);
}

export default {
	initStage: ticketStages.init,
	setStage,
	onMessage,
	onCallback,
};
