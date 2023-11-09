import { ButtonLike } from 'telegram/define';
import { Button } from 'telegram/tl/custom/button';
import { TelegramTicket, TelegramStage, cryptoNames, CryptoType } from '../manager/types';
import getText from '../texts';
import bot from './bot';
import { accounts } from './telegram';
import tgutils from './tgutils';
import { getTransaction } from '../manager/manager';
import { captureException } from '@sentry/node';
import config from '../config';

async function init(ticket: TelegramTicket, stage?: TelegramStage) {
	if (ticket.closed) {
		return;
	}

	if (!stage) {
		stage = ticket.stage;
	}

	const groupPeer = await bot.getGroupPeer(ticket.group);
	if (!groupPeer) {
		console.error('[BOT] [Init Stage] Failed to get group peer: ' + ticket.id);
		return;
	}

	const botUser1 = await bot.getUserById(ticket.user1.id);
	const botUser2 = ticket.user2 ? await bot.getUserById(ticket.user2.id) : undefined;

	switch (stage) {
		case 'select_address':
			await bot.sendMessage(groupPeer, {
				message: getText('telegram/address')
					.replace(
						'{user}',
						ticket.user1.id == ticket.result ? tgutils.mention(botUser1) : ticket.user2 && ticket.user2.id === ticket.result ? tgutils.mention(botUser2) : 'Unknown'
					)
					.replace('{crypto}', cryptoNames[ticket.user1.crypto || ticket.user2?.crypto || 'btc']),
			});
			break;
		case 'ongoing':
			// send finialize
			await bot.sendMessage(groupPeer, buildFinalize(ticket, tgutils.mention(botUser1), tgutils.mention(botUser2)));
			break;
		case 'completed':
			await bot.sendMessage(groupPeer, {
				message: getText('telegram/success')
					.replace('{main}', '@' + (accounts.find((a) => a.details.main)?.getUsername() || 'err'))
					.replace('{telegram}', getText('telegram')),
				linkPreview: false,
			});
			break;
		case 'pending':
			try {
				if (!ticket.tid) {
					throw new Error('No tid on ticket');
				}

				const txn = await getTransaction(ticket.tid);

				const text = getText('telegram/pending')
					.replace('{feeUsd}', '$0')
					.replace('{usd}', txn.txn.amountUsd)
					.replace('{totalUsd}', txn.txn.amountUsd)
					.replace('{amount}', txn.getNeededAmount())
					.replace('{crypto}', cryptoNames[txn.getCryptoType()])
					.replace('{sender}', tgutils.mention(ticket.user1.status == 'sender' ? botUser1 : botUser2))
					.replace('{address}', txn.getAddress());

				await bot.sendMessage(groupPeer, {
					message: text,
				});
			} catch (e: any) {
				console.error(e.message || e);
				captureException(e);

				await bot.sendMessage(groupPeer, {
					message: 'Failed to get transaction details. Please contact /staff',
				});
			}
			break;
		case 'accept_value':
			{
				const crypto = ticket.user1.crypto || ticket.user2?.crypto || 'btc';
				const value = ticket.user1.value || ticket.user2?.value || '-1';

				await bot.sendMessage(groupPeer, {
					message: getText('telegram/acceptvalue')
						.replace('{user}', tgutils.mention(ticket.user1.value ? botUser2 : botUser1))
						.replace('{value}', value)
						.replace('{fee}', '$0')
						.replace('{total}', parseFloat(value).toFixed(2))
						.replace('{crypto}', cryptoNames[crypto]),
					buttons: [
						Button.inline('Reject', Buffer.from('acceptvalue:' + ticket.id + ':reject', 'utf-8')),
						Button.inline('Accept', Buffer.from('acceptvalue:' + ticket.id + ':accept', 'utf-8')),
					],
				});
			}
			break;
		case 'select_value':
			await bot.sendMessage(groupPeer, {
				message: getText('telegram/selectvalue').replace('{user1}', tgutils.mention(botUser1)).replace('{user2}', tgutils.mention(botUser2)),
			});
			break;
		case 'select_status':
			await bot.sendMessage(groupPeer, buildSelectStatus(ticket, tgutils.mention(botUser1), tgutils.mention(botUser2)));
			break;
		case 'votecrypto':
			await bot.sendMessage(groupPeer, buildVoteCrypto(ticket, tgutils.mention(botUser1), tgutils.mention(botUser2)));
			break;
		case 'define':
			if (!ticket.user2) {
				break;
			}

			await bot.sendMessage(groupPeer, {
				message: getText('telegram/definedeal').replace('{user1}', tgutils.mention(botUser1)).replace('{user2}', tgutils.mention(botUser2)),
			});
			break;
		// the only stage that is sent by the main instead of the user
		case 'user_wait':
			{
				const main = accounts.find((a) => a.details.main);
				if (!main) {
					console.error('[BOT] No main account found!');
					break;
				}

				const mainGroup = await main.getGroupById(ticket.group);
				if (!mainGroup) {
					main.log('Failed to get group peer');
					break;
				}

				await main.sendMessage(mainGroup, {
					message: getText('telegram/welcome')
						.replace('{link}', 't.me/+' + ticket.invite)
						.replace('{bot}', '@' + bot.getUsername()),
				});
			}
			break;
	}
}

function buildSelectStatus(ticket: TelegramTicket, user1: string, user2: string) {
	let buttons: ButtonLike[][] | undefined = undefined;

	// only put buttons if the voting is still ongoing
	if (!ticket.user1.status || !ticket.user2?.status || ticket.user1.status == ticket.user2.status) {
		buttons = [
			[
				Button.inline('Sender', Buffer.from('selectstatus:' + ticket.id + ':sender', 'utf-8')),
				Button.inline('Receiver', Buffer.from('selectstatus:' + ticket.id + ':receiver', 'utf-8')),
			],
			[Button.inline('Clear Choice', Buffer.from('selectstatus:' + ticket.id + ':clear', 'utf-8'))],
		];
	}

	return {
		message: getText('telegram/selectstatus')
			.replace('{user1}', user1)
			.replace('{user2}', user2)
			.replace('{vote1}', typeof ticket.user1.status != 'string' ? 'None' : ticket.user1.status == 'sender' ? 'Sender' : 'Receiver')
			.replace('{vote2}', !ticket.user2 || typeof ticket.user2.status != 'string' ? 'None' : ticket.user2.status == 'sender' ? 'Sender' : 'Receiver'),

		buttons,
	};
}

function buildVoteCrypto(ticket: TelegramTicket, user1: string, user2: string) {
	const types = Object.keys(cryptoNames) as CryptoType[];
	const rawButtons: ButtonLike[] = [];

	for (const crypto of types) {
		if (config.crypto.overrides[crypto]?.disabled) {
			continue;
		}

		const prefix = ticket.user1.crypto == crypto || ticket.user2?.crypto == crypto ? '🌟 ' : '';
		rawButtons.push(Button.inline(prefix + cryptoNames[crypto], Buffer.from('selectcrypto:' + ticket.id + ':' + crypto, 'utf-8')));
	}

	// put in chunks/rows of 3
	const buttons: ButtonLike[][] = [];

	for (let i = 0; i < rawButtons.length; i += 3) {
		const slice = rawButtons.slice(i, i + 3);
		if (slice) {
			buttons.push(slice);
		}
	}

	// clear selection button
	buttons.push([Button.inline('Clear Choice', Buffer.from('selectcrypto:' + ticket.id + ':clear', 'utf-8'))]);

	return {
		message: getText('telegram/votecrypto')
			.replace('{user1}', user1)
			.replace('{user2}', user2)
			.replace('{vote1}', ticket.user1.crypto ? cryptoNames[ticket.user1.crypto] : 'None')
			.replace('{vote2}', ticket.user2?.crypto ? cryptoNames[ticket.user2.crypto] : 'None'),

		buttons,
	};
}

function buildFinalize(ticket: TelegramTicket, user1: string, user2: string) {
	return {
		message: getText('telegram/finalize')
			.replace('{user1}', user1)
			.replace('{user2}', user2)
			.replace('{vote1}', ticket.user1.vote == 'complete' ? 'Complete' : ticket.user1.vote == 'refund' ? 'Refund' : 'None')
			.replace('{vote2}', ticket.user2?.vote == 'complete' ? 'Complete' : ticket.user2?.vote == 'refund' ? 'Refund' : 'None'),

		buttons:
			// if vote is complete, don't show buttons
			ticket.user1.vote && ticket.user2?.vote && ticket.user1.vote == ticket.user2.vote
				? undefined
				: [
						[
							Button.inline('Refund', Buffer.from('finalize:' + ticket.id + ':refund', 'utf-8')),
							Button.inline('Complete', Buffer.from('finalize:' + ticket.id + ':complete', 'utf-8')),
						],
						[Button.inline('Clear Choice', Buffer.from('finalize:' + ticket.id + ':clear', 'utf-8'))],
				  ],
	};
}

export default {
	init,
	buildSelectStatus,
	buildVoteCrypto,
	buildFinalize,
};
