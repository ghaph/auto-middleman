import fs from 'fs';

export type Text =
	| 'telegram'
	| 'telegram/dmhelp'
	| 'telegram/grouptitle'
	| 'telegram/ticketcreate'
	| 'telegram/welcome'
	| 'telegram/definedeal'
	| 'telegram/votecrypto'
	| 'telegram/selectstatus'
	| 'telegram/selectvalue'
	| 'telegram/acceptvalue'
	| 'telegram/pending'
	| 'telegram/completed'
	| 'telegram/partial'
	| 'telegram/ongoing'
	| 'telegram/refunded'
	| 'telegram/success'
	| 'telegram/finalize'
	| 'telegram/ticketpanel'
	| 'telegram/address';

export default function getText(key: Text) {
	const path = `./assets/texts/${key}.txt`;
	if (!fs.existsSync(path)) {
		return '';
	}

	return fs.readFileSync(path, 'utf-8');
}
