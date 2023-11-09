import { MongoClient, Db, Collection } from 'mongodb';
import config from '../config';
import { sleep } from '../utils';
import { BannedUser, Origin, PartialVouch, TelegramTicket, Transaction, UserData, UserUpdateCallback, Vouch } from './types';
import { captureException } from '@sentry/node';

const client: MongoClient = new MongoClient(config.mongo.url);
const db: Db = client.db(config.mongo.dbName);

export const usersCollection: Collection<UserData> = db.collection('users');
export const txnsCollection: Collection<Transaction> = db.collection('txns');
export const telegramCollection: Collection<TelegramTicket> = db.collection('telegram');
export const vouchesCollection: Collection<Vouch> = db.collection('vouches');
export const bansCollection: Collection<BannedUser> = db.collection('bans');

const usersLock: { [key: string]: boolean } = {};
let globalUserLock = false;
let vouchLock = false;

// userid is the discord / telegram user id if string else if no origin is set then internal id
// updater returns undefined if no update is needed
async function updateUser(userid: string | number, origin: Origin | undefined, updater: UserUpdateCallback) {
	const uidStr = userid.toString();
	while (usersLock[uidStr]) {
		await sleep(100);
	}

	usersLock[uidStr] = true;

	try {
		let user: UserData | null = await usersCollection.findOne(
			!origin
				? {
						id: parseInt(userid.toString()),
				  }
				: origin == 'telegram'
				? {
						telegram: userid.toString(),
				  }
				: {
						discord: userid.toString(),
				  }
		);

		if (!user) {
			while (globalUserLock) {
				await sleep(100);
			}

			globalUserLock = true;

			try {
				let currentId = (await usersCollection.find().sort({ id: -1 }).limit(1).toArray())[0]?.id;
				if (currentId == undefined || typeof currentId != 'number') {
					currentId = -1;
				}

				user = {
					id: currentId + 1,
					createdAt: new Date().toISOString(),
				};

				if (origin) {
					user[origin] = uidStr;
				}
			} finally {
				globalUserLock = false;
			}
		}

		const updated = await updater(user);
		if (updated) {
			const result = await usersCollection.updateOne({ id: user.id }, { $set: updated });
			if (!result.acknowledged || result.matchedCount <= 0) {
				try {
					await usersCollection.insertOne(user);
				} catch (e) {
					console.error(e);
					captureException(e);
				}
			}
		}
	} catch (e) {
		console.error(e);
		captureException(e);
	} finally {
		usersLock[uidStr] = false;
	}
}

let ready = false;
(async () => {
	try {
		await client.connect();
		ready = true;
	} catch (e) {
		console.error(e);
		captureException(e);

		await sleep(2000);
		process.exit();
	}

	try {
		await db.createCollection(usersCollection.collectionName);
	} catch {}

	try {
		await db.createCollection(txnsCollection.collectionName);
	} catch {}

	try {
		await db.createCollection(telegramCollection.collectionName);
	} catch {}

	try {
		if (!(await usersCollection.indexExists('id'))) {
			await usersCollection.createIndex({ id: 1 }, { unique: true });
		}

		// only 1 discord acc per users
		if (!(await usersCollection.indexExists('discord'))) {
			await usersCollection.createIndex({ discord: 1 }, { unique: true, sparse: true });
		}

		// only 1 telegram acc per user
		if (!(await usersCollection.indexExists('telegram'))) {
			await usersCollection.createIndex({ telegram: 1 }, { unique: true, sparse: true });
		}
	} catch {}

	try {
		await bansCollection.createIndex({ id: 1, origin: 1 }, { unique: true });
	} catch {}

	try {
		if (!(await txnsCollection.indexExists('id'))) {
			await txnsCollection.createIndex({ id: 1 }, { unique: true });
		}
	} catch {}

	try {
		// only 1 channel per ticket
		if (!(await telegramCollection.indexExists('id'))) {
			await telegramCollection.createIndex({ id: 1 }, { unique: true });
		}
	} catch {}

	console.log('Connected to MongoDB');
})();

async function getSuccessfulMMs(): Promise<number> {
	return await txnsCollection.countDocuments({ status: 'completed' });
}

async function getUserStats(uid: string | number, origin?: Origin): Promise<UserData | undefined> {
	try {
		const user = await usersCollection.findOne(
			!origin
				? {
						id: parseInt(uid.toString()),
				  }
				: origin == 'telegram'
				? {
						telegram: uid.toString(),
				  }
				: {
						discord: uid.toString(),
				  }
		);

		if (!user) {
			return undefined;
		}

		delete (user as any)['_id'];
		return user;
	} catch {}

	return undefined;
}

// can only vouch every 12 hours
async function createVouch(vouchData: PartialVouch): Promise<Vouch | undefined> {
	while (vouchLock) {
		await sleep(100);
	}

	vouchLock = true;

	try {
		// get the newest vouch from this user
		const found = (await vouchesCollection.find({ uid: vouchData.uid, origin: vouchData.origin }).sort({ date: -1 }).limit(1).toArray())[0];
		if (found && (found.msg == vouchData.msg || Date.now() - found.date.getTime() < 1000 * 60 * 60)) {
			return undefined;
		}

		let currentId = (await vouchesCollection.find().sort({ id: -1 }).limit(1).toArray())[0]?.id;
		if (currentId == undefined || typeof currentId != 'number') {
			currentId = 0;
		}

		const vouch: Vouch = {
			id: currentId + 1,
			...vouchData,
		};

		try {
			await vouchesCollection.insertOne(vouch);
		} catch (e) {
			console.error(e);
			captureException(e);

			return undefined;
		}

		return vouch;
	} finally {
		vouchLock = false;
	}
}

async function getVouchById(id: number): Promise<Vouch | undefined> {
	return (await vouchesCollection.findOne({ id })) as Vouch | undefined;
}

async function isUserBanned(id: string | number, origin: Origin): Promise<boolean> {
	return (await bansCollection.countDocuments({ id: id.toString(), origin })) > 0;
}

export default {
	isReady: () => {
		return ready;
	},
	updateUser,
	getSuccessfulMMs,
	getUserStats,
	createVouch,
	getVouchById,
	isUserBanned,
};
