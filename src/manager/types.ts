// only created once a successful deal has been made
export type UserData = UserStaticData & UserChangableData;
export type UserUpdateCallback = (user: UserData) => Promise<UserChangableData | undefined>;

export type UserStaticData = {
	// the date the profile was initialized (in ISO format)
	createdAt: string;

	// their internal user id - can never change, counts up from 0
	// their profile only gets created after a successful deal
	id: number;
};

export type UserChangableData = {
	// their telegram id - can never change
	telegram?: string;
	// their discord id - can change, is tied to telegram id
	discord?: string;

	stats?: UserStats;

	// the ids of the transactions theyve been apart of
	txns?: number[];
};

export type UserStats = {
	// the amount of middleman deals theyve been apart of that have been completed
	mms?: number;

	// the total amount of money received (in $, rounded to 2 points)
	received?: string;

	// the total amount of money sent (in $, rounded to 2 points)
	sent?: string;

	// the balance they have in the bot (in usd, rounded to 4 points)
	balance?: string;
};

export type Transaction = {
	// counts up from 0
	id: number;

	status: TransactionStatus;
	// the last time the status was updated (in ISO format)
	statusUpdated?: Date;

	// the date the transaction was made (in ISO format)
	date: Date;

	// amount (incl fee) in crypto value (in sats)
	amount: number;

	// amount at the start of the transaction excl fee
	amountUsd: string;

	// their internal uids - only set after deal is completed
	//sender?: number;
	//receiver?: number;

	origin: Origin;
	users: OriginData;

	wallet: {
		// the account id
		account: string;
		// the index of the account
		index: number;
		address?: string;

		// the outgoing txid for completion / refund
		txid?: string;
	};

	crypto: CryptoType;

	// whether this transaction has been paid out or not
	paidOut?: boolean;
};

export type Origin = 'telegram' | 'discord';
export type CryptoType = 'btc' | 'ltc' | 'eth';
export type TransactionStatus =
	// the transaction is waiting for incoming crypto transactions
	| 'pending'
	// the transaction has been paid and waiting for it to be confirmed / refunded
	| 'ongoing'
	// the transaction has been paid partially and waiting for more payments to be sent
	| 'partial'
	// the transaction is fully completed and payments have been sent
	| 'completed'
	// the transaction has been refunded (excl mm fee)
	| 'refunded'
	// the transaction timed out or the users individually canced it
	| 'cancelled';

export const cryptoNames: { [key in CryptoType]: string } = {
	btc: 'Bitcoin',
	ltc: 'Litecoin',
	eth: 'Ethereum',
};

export const cryptoLogos: { [key in CryptoType]: string } = {
	btc: 'https://cryptologos.cc/logos/bitcoin-btc-logo.png',
	ltc: 'https://cryptologos.cc/logos/litecoin-ltc-logo.png',
	eth: 'https://cryptologos.cc/logos/ethereum-eth-logo.png',
};

export const cryptoColors: { [key in CryptoType]: number } = {
	btc: 0xf7931a,
	ltc: 0x345d9d,
	eth: 0x627eea,
};

export type OriginData = {
	// the telegram / user ids of the sender and receiver
	sender: string;
	receiver: string;
};

export type Message = {
	// content of the message
	ct: string;

	// the author
	at: string;

	t: Date;

	deleted?: boolean;

	// list of links to discord attachments
	attachments?: string[];
};

export type TelegramTicket = {
	// the internal ticket id
	id: number;
	// this is the id of the ticket, without the -100 at the start
	group: number;

	// the user id of the account that hosts the group
	host: number;

	// the invite link without the t.me/+ prefix
	invite: string;

	created: Date;
	stage: TelegramStage;

	// the date the stage was last updated
	updated?: Date;

	user1: TelegramUser;
	user2?: TelegramUser;

	// the transaction id of the ticket
	tid?: number;
	closed?: boolean;
	closedAt?: Date;

	// result is the user id of the person who is receiving the funds
	result?: number;

	// the outcome of the ticket
	status?: 'complete' | 'refund';

	// this doesnt get sent to the database. just used internally when sometime types /close, it starts a timer
	closing?: boolean;

	// whether staff were called to the ticket or not
	staff?: boolean;

	// key is message id, value is message
	messages?: {
		[key: string]: TelegramMessage;
	};
};

export type TelegramMessage = {
	// content of the message
	ct: string;

	// the author id
	at: number;

	bot?: boolean;

	deleted?: boolean;
};

type TelegramUser = {
	id: number;

	// the last seen username / first name
	name?: string;

	// if true user has requested a close
	close?: boolean;

	// if true user has requested a kick of all users
	kick?: boolean;

	value?: string;
	crypto?: CryptoType;
	status?: 'sender' | 'receiver';
	vote?: 'complete' | 'refund';
};

export type TelegramStage =
	// waiting for the user to join the group
	| 'waiting'
	// waiting for the user who joined the group to invite the other user
	| 'user_wait'
	| 'define'
	// they select the crypto they want to use
	| 'votecrypto'
	// they agree on who the reciver is and who the sender is
	| 'select_status'
	// they select the value of the deal
	| 'select_value'
	| 'accept_value'
	// means we are waiting for crypto to be sent
	| 'pending'
	// waiting for the refund / completion tx to be agreed on and sent
	| 'ongoing'
	// waiting for user to select address
	| 'select_address'
	// completed means the funds were either sent to the receiver or refunded to the sender
	// waiting for users to agree to close the ticket. ticket will be automatically closed after 1 hour of inactivity
	| 'completed';

export type BannedUser = {
	id: string;
	origin: Origin;
	reason: string;
	date: Date;
};

export type Vouch = {
	id: number;
} & PartialVouch;

export type PartialVouch = {
	// the user id of the person who vouched
	uid: string;

	origin: Origin;
	date: Date;
	msg: string;
};

export type Giveaway = {
	id: number;
	created: Date;
	ends: Date;

	// the amount of winners
	winners: number;

	data: DiscordGiveaway | TelegramGiveaway;
};

type DiscordGiveaway = {
	type: 'discord';
	channel: string;
	participants: string[];
};

type TelegramGiveaway = {
	type: 'telegram';
	channel: number;
	topicId?: number;
	participants: {
		id: number;

		// the bot's access hash to this user
		hash: string;
	}[];
};
