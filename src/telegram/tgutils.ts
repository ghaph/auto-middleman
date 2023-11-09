import { Api } from 'telegram';
import { BigInteger } from 'big-integer';
import config from '../config';

function getUsername(user: Api.User | undefined): string | undefined {
	if (!user) {
		return undefined;
	}

	return user.username || (user.usernames && user.usernames.length > 0 && user.usernames[0].username) || undefined;
}

// either user object or user id
function mention(user: Api.User | string | number | undefined, parseMode: 'html' | 'md' = 'html'): string {
	if (!user) {
		return 'None';
	}

	if (typeof user == 'string' || typeof user == 'number') {
		return parseMode == 'md' ? `[${user}](tg://user?id=${user})` : `<a href="tg://user?id=${user}">${user.toString().replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a>`;
	}

	const username = getUsername(user);
	if (!username) {
		return parseMode == 'md' ? `[${user.firstName}](tg://user?id=${user.id})` : `<a href="tg://user?id=${user.id}">${user.firstName?.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a>`;
	}

	return `@${username}`;
}

function toChatId(id: number | string | BigInteger): number {
	if (typeof id != 'string') {
		id = id.toString();
	}

	if (!id.startsWith('-100')) {
		id = `-100${id}`;
	}

	return parseInt(id);
}

export default {
	getUsername,
	// gets a generic name for a user
	getName: (user: Api.User) => getUsername(user) || user.firstName || 'None',
	toChatId,
	mention,
	// todo
	isStaff: (user: Api.User | number) => config.telegram.staff.includes(typeof user == 'number' ? user : user.id.toJSNumber()) || (typeof user != 'number' && config.telegram.staff.includes(getUsername(user) || '0')),
};
