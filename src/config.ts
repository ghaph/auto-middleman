import chalk from 'chalk';
import fs from 'fs';
import { CryptoType } from './manager/types';
import { captureException } from '@sentry/node';

const configPath = './config.json';

const config: ConfigData = {
	mongo: {
		url: 'mongodb://localhost:27017',
		dbName: 'automm',
	},
	telegram: {
		enabled: false,
		apiId: 0,
		apiHash: '',
		botToken: '',
		accs: [],
		maxUnpaidTickets: 2,
		groupDescription: 'The Automated Middleman',
		staff: [],
		checkMembersDelay: 4000,
		vouchChannel: undefined,
	},
	crypto: {
		accounts: [
			{
				mnemonic: '',
				dontUse: false,
			},
		],
		addresses: {},
		pendingTimeoutHours: 24,
		confirmations: 3,
		minAmount: 3,
		checkReqDelay: 7500,
		overrides: {},
	},
};

if (!fs.existsSync(configPath)) {
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
	console.log(chalk.greenBright('Config file created, please fill it out and restart the bot'));
	process.exit();
} else {
	load(true);
}

function load(ignorePrint?: boolean) {
	try {
		const newConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		if (JSON.stringify(config) !== JSON.stringify(newConfig)) {
			if (!ignorePrint) {
				console.log(chalk.yellowBright('Config file changed, updating...'));
			}
			Object.assign(config, newConfig);
		}
	} catch (e) {
		console.error(e);
		captureException(e);
	}
}

export default config;

export function saveConfig() {
	fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
}

setInterval(load, 1000);

export type ConfigData = {
	mongo: {
		url: string;
		dbName: string;
	};
	telegram: {
		enabled: boolean;
		apiId: number;
		apiHash: string;
		botToken: string;
		maxUnpaidTickets: number;
		groupDescription: string;
		checkMembersDelay: number;

		// format - <channel id:topic id> OR <channel id>
		vouchChannel: string | undefined;

		// list of user ids that are staff
		staff: (number | string)[];

		// priority is from first to last
		accs: TelegramDetails[];
	};
	crypto: {
		accounts: MnemonicAccount[];

		addresses: { [key in CryptoType]?: string };

		// the amount of time to wait for a crypto transaction before cancelling and giving address to new txn
		pendingTimeoutHours: number;

		// required confirmations for crypto transactions
		confirmations: number;

		// the minimum amount of money that can be sent in a crypto txn (in usd)
		minAmount: number;

		overrides: { [key in CryptoType]?: CryptoOverride };

		checkReqDelay: number;
	};
};

export type MnemonicAccount = {
	mnemonic: string;
	dontUse: boolean;
};

export type TelegramDetails = {
	phone: string;
	name: string;

	// if enabled dont use this to host anymore tickets
	dontUse?: boolean;

	// if enabled then the account will be able to recieve dms to create tickets
	// should only be 1 main account
	main?: boolean;
};

type CryptoOverride = {
	disabled?: boolean;
	confirms?: number;
	minAmount?: number;
	fee?: number;
	minFee?: number;
};
