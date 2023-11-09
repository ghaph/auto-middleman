import BigNumber from 'bignumber.js';
import database, { txnsCollection } from './manager/database';
import { getTransaction, satsToCrypto } from './manager/manager';
import { CryptoType, cryptoNames } from './manager/types';
import { question, sleep } from './utils';

(async () => {
	while (!database.isReady()) {
		await sleep(100);
	}

	const crypto = (await question('Enter the crypto symbol to payout: ')) as CryptoType;
	if (!cryptoNames[crypto]) {
		console.log('Invalid crypto');
		process.exit(1);
	}

	console.log('Selected crypto:', cryptoNames[crypto]);

	const address = (await question('Enter the address to send to: ')) as string;
	if (!address) {
		console.log('Invalid address');
		process.exit(1);
	}

	const availableTxns = await txnsCollection
		.find({
			status: { $in: ['completed', 'refunded'] },
			paidOut: { $exists: false },
			crypto,
		})
		.toArray();

	console.log('Found', availableTxns.length, 'transactions to payout. Running now, do not close program');

	for (const txnData of availableTxns) {
		const txn = await getTransaction(txnData.id);
		if (!txn) {
			console.log(`Failed to get transaction ${txnData.id}`);
			continue;
		}

		const balance = ((await txn.getBalance()) || 0) - 0.1;
		if (balance <= 0) {
			console.log(`[${txn.getAddress()}] This wallet does not have a balance`);
			continue;
		}

		console.log(`Paying out ${satsToCrypto(balance, crypto)} ${crypto.toUpperCase()} to ${address}`);
		try {
			const resp = await txn.forceSend(address, balance);
			if (resp.toLowerCase().includes('fail') || resp.toLowerCase().includes('error')) {
				throw new Error(resp);
			}

			console.log(resp);
			await txnsCollection.updateOne({ id: txn.txn.id }, { $set: { paidOut: true } });
		} catch (e) {
			console.error(e);
		}
	}
})();
