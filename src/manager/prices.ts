import { captureException } from '@sentry/node';
import { CryptoType, cryptoNames } from './types';
import fetch from 'node-fetch';

let ready = false;

const prices: { [key in CryptoType]: number } = {
	btc: 0,
	ltc: 0,
	eth: 0,
};

async function updatePrices() {
	try {
		let ids = '';
		for (const [key, value] of Object.entries(cryptoNames)) {
			ids += value.toLowerCase() + ',';
		}
		ids = ids.slice(0, -1);

		const data = await (await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`)).json();

		for (const [key, value] of Object.entries(data)) {
			for (const [ctype, name] of Object.entries(cryptoNames)) {
				if (name.toLowerCase() == key) {
					prices[ctype as CryptoType] = (value as any).usd;
					break;
				}
			}
		}
		ready = true;
	} catch (e) {
		console.error(e);
		captureException(e);
	}
}

export function isPricesReady(): boolean {
	return ready;
}

export default prices;

updatePrices();
setInterval(updatePrices, 1000 * 60);
