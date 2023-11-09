import database, { txnsCollection } from './database';
import { CryptoType, Origin, OriginData, Transaction, TransactionStatus, UserChangableData, UserUpdateCallback, cryptoNames } from './types';
import CryptoAccount from '../cryptolib/index';
import config, { MnemonicAccount } from '../config';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { BIP32Interface } from 'bip32';
import { mnemonicToSeedSync } from 'bip39';
import { EventEmitter } from 'node:events';
import prices, { isPricesReady } from './prices';
import { sleep } from '../utils';
import BigNumber from 'bignumber.js';
import { captureException } from '@sentry/node';
import { Value } from '../cryptolib/types/types';
import { createHash } from 'node:crypto';

const active: ActiveTransaction[] = [];
let transactionLock = false;

// throws error
export async function createTransaction(usd: number | string, crypto: CryptoType, users: OriginData, origin: Origin): Promise<ActiveTransaction> {
	while (transactionLock || !isPricesReady()) {
		await sleep(100);
	}

	transactionLock = true;

	try {
		if (typeof usd != 'number') {
			usd = parseFloat(usd);
		}
		const value = parseFloat(usd.toFixed(2));

		const minAmount = config.crypto.overrides[crypto]?.minAmount || config.crypto.minAmount;
		if (value < minAmount) {
			throw new Error('Minimum transaction amount is $' + minAmount);
		}

		const price = prices[crypto];
		if (!price || price <= 0) {
			throw new Error('There was an error getting the price for that crypto');
		}

		const validAccounts = config.crypto.accounts.filter((acc) => !acc.dontUse);
		if (validAccounts.length == 0) {
			throw new Error('No valid accounts found');
		}

		const acc = validAccounts[Math.floor(Math.random() * validAccounts.length)];

		// 1 + decimals * '0'
		const times = crypto == 'eth' ? 1000000000000000000 : 100000000;

		let currentId = (await txnsCollection.find().sort({ id: -1 }).limit(1).toArray())[0]?.id;
		if (currentId == undefined || typeof currentId != 'number') {
			currentId = -1;
		}
		const txn: Transaction = {
			id: currentId + 1,
			amount: Math.round((value / price) * times),
			amountUsd: value.toFixed(2),
			crypto,
			users,
			date: new Date(),
			origin,
			status: 'pending',
			wallet: {
				// find below
				index: await getNextIndex(crypto, getMnemonicHash(acc)),
				account: getMnemonicHash(acc),
			},
		};

		await txnsCollection.insertOne(txn);

		const atx = new ActiveTransaction(txn);
		active.push(atx);

		return atx;
	} finally {
		transactionLock = false;
	}
}

async function getNextIndex(crypto: CryptoType, account: string) {
	// Fetch all documents with the given crypto and wallet.account, whose status is not 'cancelled'
	const txns = await txnsCollection
		.find({ crypto, 'wallet.account': account, status: { $ne: 'cancelled' } })
		.project({ 'wallet.index': 1 })
		.sort({ 'wallet.index': 1 })
		.toArray();

	if (txns.length == 0) {
		return 0;
	}

	const largest = txns.reduce((prev, curr) => (curr.wallet.index > prev ? curr.wallet.index : prev), 0);

	outer: for (let i = 0; i < largest; i++) {
		for (const txn of txns) {
			if (txn.wallet.index == i) {
				continue outer;
			}
		}

		return i;
	}

	return largest + 1;
}

// throws error if not found
export async function getTransaction(tid: number): Promise<ActiveTransaction> {
	while (transactionLock) {
		await sleep(100);
	}

	transactionLock = true;

	try {
		for (const atx of active) {
			if (atx.txn.id == tid) {
				return atx;
			}
		}

		const txn = await txnsCollection.findOne({ id: tid });
		if (!txn) {
			throw new Error('Transaction not found');
		}

		const atx = new ActiveTransaction(txn);
		active.push(atx);

		return atx;
	} finally {
		transactionLock = false;
	}
}

const bip32 = BIP32Factory(ecc);

/*
Events:

status_update: The status of the txn has changed
*/
export class ActiveTransaction extends EventEmitter {
	public txn: Transaction;
	private wallet: CryptoAccount;
	private listening: boolean = false;

	// this is used incase replaceTxn is called multiple times in a short period of time
	// we dont want to replace it many times in a second as thats a waste of resources
	private replaceTimer: NodeJS.Timeout | null = null;

	constructor(txn: Transaction) {
		super();
		this.txn = txn;

		const acc = config.crypto.accounts.find((acc) => getMnemonicHash(acc) == txn.wallet.account);
		if (!acc) {
			throw new Error('Account not found');
		}

		// Convert the mnemonic into a seed
		const seed = mnemonicToSeedSync(acc.mnemonic);
		const master: BIP32Interface = bip32.fromSeed(seed);

		const child: BIP32Interface = master.derivePath(`m/44'/${this.txn.crypto == 'eth' ? 60 : this.txn.crypto == 'ltc' ? 2 : 0}'/0'/0/${this.txn.wallet.index}`);

		if (!child.privateKey) {
			throw new Error('Failed to derive private key');
		}

		this.wallet = new CryptoAccount(child.privateKey?.toString('hex'));

		const newAddr = this.wallet.address(this.txn.crypto);
		if (!this.txn.wallet.address || this.txn.wallet.address !== newAddr) {
			this.txn.wallet.address = newAddr;
			this.replaceTxn();
		}

		if (!this.txn.status) {
			this.setStatus('pending');
		}

		// start listening if the txn is pending
		this.startListening();
	}

	onStatusUpdate(callback: (old: TransactionStatus, status: TransactionStatus, balance?: number) => void) {
		this.on('status', callback);
	}

	async finalize(address: string, status: 'completed' | 'refunded', force?: boolean): Promise<string> {
		let success = true;

		if (this.txn.status == 'completed' || this.txn.wallet.txid) {
			success = false;
			if (!force) return 'Transaction already completed';
		}

		if (this.txn.status == 'refunded') {
			success = false;
			if (!force) return 'Transaction already refunded';
		}

		if (this.txn.status == 'cancelled') {
			success = false;
			if (!force) return 'Transaction has been cancelled';
		}

		if (this.txn.status != 'ongoing') {
			success = false;
			if (!force) return 'Cannot send money when transaction is not ongoing';
		}

		if (!this.setStatus(status) && !force) {
			success = false;
			if (!force) return 'Transaction already completed';
		}

		// if a force send, dont update user info twice
		if (status == 'completed' && success) {
			database.updateUser(this.txn.users.receiver, this.txn.origin, async (user) => {
				const update: UserChangableData = {};

				if (!user.txns || !user.txns.includes(this.txn.id)) {
					update.txns = (user.txns || []).concat(this.txn.id);
				}

				update.stats = user.stats || {};
				update.stats.mms = (update.stats.mms || 0) + 1;
				update.stats.received = ((parseFloat(update.stats.received || '0') || 0) + parseFloat(this.txn.amountUsd)).toFixed(2);

				return update;
			});

			database.updateUser(this.txn.users.sender, this.txn.origin, async (user) => {
				const update: UserChangableData = {};

				if (!user.txns || !user.txns.includes(this.txn.id)) {
					update.txns = (user.txns || []).concat(this.txn.id);
				}

				update.stats = user.stats || {};
				update.stats.mms = (update.stats.mms || 0) + 1;
				update.stats.sent = ((parseFloat(update.stats.sent || '0') || 0) + parseFloat(this.txn.amountUsd)).toFixed(2);

				return update;
			});
		}

		const sending = this.txn.amount;

		const balance = await this.getBalance();
		if (balance < sending) {
			return 'Not enough balance to send (' + balance + ')';
		}

		return this.forceSend(address, new BigNumber(sending.toString()));
	}

	forceSend(address: string, amount: Value): Promise<string> {
		return new Promise((resolve) => {
			let fee = undefined;
			switch (this.txn.crypto) {
				case 'btc':
					fee = 7500;
					break;
				case 'ltc':
					fee = 10000;
					break;
			}
			const e = this.wallet.sendSats(address, amount, this.txn.crypto, {
				subtractFee: true,
				changeAddress: config.crypto.addresses[this.txn.crypto],
				fee,
			});

			e.catch((e) => {
				console.error(e);
				captureException(e);

				resolve('Failed to send transaction');
			});

			e.on('transactionHash', (hash) => {
				if (!this.txn.wallet.txid) {
					this.txn.wallet.txid = hash;
					this.replaceTxn();
				}

				if (this.txn.crypto == 'eth') {
					return resolve(`https://etherscan.io/tx/${hash}`);
				}

				return resolve(`https://blockchair.com/${cryptoNames[this.txn.crypto].toLowerCase()}/transaction/${hash}`);
			});

			e.on('error', (e) => {
				resolve(e.message);
			});
		});
	}

	startListening() {
		if (this.listening || !this.isWaitingForTxns()) {
			return;
		}

		this.listening = true;
		const atx = this;

		const interval = setInterval(async () => {
			if (!this.isWaitingForTxns()) {
				clearInterval(interval);
				atx.listening = false;
				return;
			}

			try {
				await atx.checkUpdates();
			} catch (e) {
				console.error(e);
				captureException(e);
			}
		}, config.crypto.checkReqDelay);
	}

	// check updates from pending to ongoing / partial
	async checkUpdates() {
		if (!this.isWaitingForTxns()) {
			return;
		}

		const balance = await this.getBalance();
		if (balance >= this.txn.amount) {
			this.setStatus('ongoing', balance);
		} else if (balance > 0) {
			this.setStatus('partial', balance);
		}

		if (this.txn.status == 'pending' && Date.now() - new Date(this.txn.date).getTime() > config.crypto.pendingTimeoutHours * 60 * 60 * 1000) {
			this.setStatus('cancelled', balance);
		}
	}

	public isWaitingForTxns(): boolean {
		return this.txn.status == 'pending' || this.txn.status == 'partial';
	}

	getAddressUrl(): string {
		return `https://blockchair.com/${cryptoNames[this.txn.crypto].toLowerCase()}/address/${this.getAddress()}`;
	}

	getAddress(): string {
		return this.txn.wallet.address || '';
	}

	getCryptoType(): CryptoType {
		return this.txn.crypto;
	}

	getNeededAmount(): string {
		return satsToCrypto(this.txn.amount, this.txn.crypto);
	}

	async getBalanceWhole(): Promise<string> {
		return satsToCrypto(await this.getBalance(), this.txn.crypto);
	}

	async getBalance(): Promise<number> {
		if (!this.txn.wallet.address) {
			return 0;
		}

		try {
			return await this.wallet.getBalanceInSats(this.txn.crypto, {
				address: this.txn.wallet.address,

				confirmations: config.crypto.overrides[this.txn.crypto]?.confirms || config.crypto.confirmations,
			});
		} catch (e: any) {
			console.error(e.message || e);
		}

		return 0;
	}

	getStatus() {
		return this.txn.status;
	}

	setStatus(status: TransactionStatus, balance?: number): boolean {
		const old = this.txn.status;
		if (status == old) {
			return false;
		}

		this.txn.status = status;
		this.txn.statusUpdated = new Date();
		console.log(`[${this.txn.id}] Status changed from ${old} to ${status}!`);

		this.emit('status', old, status, balance);

		// todo create profiles / update user stats

		this.replaceTxn();
		return true;
	}

	private replaceTxn() {
		if (this.replaceTimer) {
			return;
		}

		const atx = this;
		this.replaceTimer = setTimeout(async () => {
			atx.replaceTimer = null;
			try {
				const res = await txnsCollection.replaceOne({ id: atx.txn.id }, atx.txn);
				if (res.matchedCount == 0 && res.acknowledged) {
					await txnsCollection.insertOne(atx.txn);
				}
			} catch (e) {
				console.error(e);
				captureException(e);
			}
		}, 1000);
	}
}

export function getDecimals(crypto: CryptoType) {
	return crypto == 'eth' ? 18 : 8;
}

export function satsToCrypto(sats: number | BigNumber, crypto: CryptoType): string {
	if (typeof sats == 'number') {
		sats = new BigNumber(sats);
	}

	return sats.dividedBy(new BigNumber(10).exponentiatedBy(getDecimals(crypto))).toString();
}

const rainbowTable: { [key: string]: string } = {};

// we dont want to store mnemonic on database for security reasons
export function getMnemonicHash(acc: MnemonicAccount) {
	const cached = rainbowTable[acc.mnemonic];
	if (cached) {
		return cached;
	}

	const hash = createHash('md5').update(mnemonicToSeedSync(acc.mnemonic)).digest('hex');
	rainbowTable[acc.mnemonic] = hash;

	return hash;
}
