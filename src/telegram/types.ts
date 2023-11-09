import { Api } from 'telegram';

export type GroupData = {
	chat: Api.Channel;
	users: Api.User[];
};
