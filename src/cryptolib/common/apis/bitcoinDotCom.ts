import axios from 'axios';

import { fixUTXO, fixUTXOs, fixValue, sortUTXOs, UTXO } from '../../lib/utxo';
import { FetchTXsResult } from './insight';
import { DEFAULT_TIMEOUT } from './timeout';

const endpoint = (testnet: boolean) => (testnet ? 'https://trest.bitcoin.com/v2/' : 'https://rest.bitcoin.com/v2/');

const endpointV2 = (testnet: boolean) => (testnet ? 'https://explorer-tbch.api.bitcoin.com/tbch/v1' : 'https://explorer.api.bitcoin.com/bch/v1');

const fetchUTXO =
	(testnet: boolean) =>
	async (txHash: string, vOut: number): Promise<UTXO> => {
		const url = `${endpointV2(testnet)}/tx/${txHash}`;

		const response = await axios.get<FetchTXResponse>(`${url}`, {
			timeout: DEFAULT_TIMEOUT,
		});

		const utxo = response.data;

		return fixUTXO(
			{
				txHash,
				amount: parseFloat(utxo.vout[vOut].value),
				// script_hex: utxo.scriptPubKey,
				vOut,
				confirmations: utxo.confirmations,
			},
			8
		);
	};

const fetchUTXOs =
	(testnet: boolean) =>
	async (address: string, confirmations: number): Promise<readonly UTXO[]> => {
		const url = `${endpointV2(testnet)}/addr/${address}/utxo`;
		const response = await axios.get<FetchUTXOSResponse>(url, {
			timeout: DEFAULT_TIMEOUT,
		});
		return fixUTXOs(
			response.data
				.map((utxo) => ({
					txHash: utxo.txid,
					amount: utxo.amount,
					// script_hex: utxo.scriptPubKey,
					vOut: utxo.vout,
					confirmations: utxo.confirmations,
				}))
				.filter((utxo) => confirmations === 0 || utxo.confirmations >= confirmations),
			8
		).sort(sortUTXOs);
	};

const fetchTXs =
	(testnet: boolean) =>
	async (address: string, confirmations: number): Promise<readonly UTXO[]> => {
		const url = `${endpoint(testnet).replace(/\/$/, '')}/address/transactions/${address}`;
		const { data } = await axios.get<FetchTXsResult>(url, {
			timeout: DEFAULT_TIMEOUT,
		});

		const received: UTXO[] = [];

		for (const tx of data.txs) {
			for (let i = 0; i < tx.vout.length; i++) {
				const vout = tx.vout[i];
				if (vout.scriptPubKey.addresses.indexOf(address) >= 0) {
					received.push({
						txHash: tx.txid,
						amount: fixValue(parseFloat(vout.value), 8),
						vOut: i,
						confirmations: tx.confirmations,
					});
				}
			}
		}

		return received.filter((utxo) => confirmations === 0 || utxo.confirmations >= confirmations).sort(sortUTXOs);
	};

export const broadcastTransaction =
	(testnet: boolean) =>
	async (txHex: string): Promise<string> => {
		const url = `${endpoint(testnet).replace(/\/$/, '')}/rawtransactions/sendRawTransaction`;
		const response = await axios.post<string[]>(url, { hexes: [txHex] }, { timeout: DEFAULT_TIMEOUT });
		if ((response.data as any).error) {
			throw new Error((response.data as any).error);
		}
		return response.data[0];
	};

export const BitcoinDotCom = {
	fetchUTXO,
	fetchUTXOs,
	fetchTXs,
	broadcastTransaction,
};

type FetchUTXOSResponse = Array<{
	address: string; // "miMi2VET41YV1j6SDNTeZoPBbmH8B4nEx6";
	txid: string; // "cfa3301a29937b0571b759a9af895b713214060aaeef2ac35b9d290dd7d10553";
	vout: number; // 1;
	scriptPubKey: string; // "76a9141f28b9198368dcc57cbdadd55092ba8d0cfc0cdb88ac";
	amount: number; // 1.39903978;
	satoshis: number; // 139903978;
	height: number; // 1401543;
	confirmations: number; // 21295;
}>;

type FetchTXResponse = {
	txid: string; // "cfa3301a29937b0571b759a9af895b713214060aaeef2ac35b9d290dd7d10553";
	version: number; // 1;
	locktime: number; // 0;
	vin: Array<{
		txid: string; // "195e1f3a70235216e1e61c19b3c3b89c6384f707f5c68b0570c30603eed72f12";
		vout: number; // 0;
		sequence: number; // 4294967295;
		n: number; // 0;
		scriptSig: {
			hex: string; // "4730440220732686ea0e3582e23a0008682b215bc8b03bd4ecb730828f94d28df2b3fa865f0220310273bb51e727bbb6e2e816ec6c4f79276508d9f634b183450dabd38898d8ca41210268ccfdd69648ff16ddc607994462d235b520bc29f5b1f88d3e4a6403971f1413";
			asm: string; // "30440220732686ea0e3582e23a0008682b215bc8b03bd4ecb730828f94d28df2b3fa865f0220310273bb51e727bbb6e2e816ec6c4f79276508d9f634b183450dabd38898d8ca41 0268ccfdd69648ff16ddc607994462d235b520bc29f5b1f88d3e4a6403971f1413";
		};
		addr: string; // "miMi2VET41YV1j6SDNTeZoPBbmH8B4nEx6";
		valueSat: number; // 11769;
		value: number; // 0.00011769;
		doubleSpentTxID: null; // null;
	}>;
	vout: Array<{
		value: string; // "0.10000000";
		n: number; // 0;
		scriptPubKey: {
			hex: string; // "76a914eb7af4368d7c9365a09f445827b8a6841792773388ac";
			asm: string; // "OP_DUP OP_HASH160 eb7af4368d7c9365a09f445827b8a68417927733 OP_EQUALVERIFY OP_CHECKSIG";
			addresses: number; // ["n2z4P8CQxeDMeckx817v9qvkfNsxMpC48E"];
			type: string; // "pubkeyhash";
		};
		spentTxId: string; // "7a794b095f169f554ff89df2c07179803fb6a71496fd1e3a1ff273641d8050ac";
		spentIndex: number; // 2;
		spentHeight: number; // 1403107;
	}>;
	blockhash: string; // "00000000001d49c2bf7a8509e4f35aa49f091801c144ed9046cff4354bea7389";
	blockheight: number; // 1401543;
	confirmations: number; // 21295;
	time: number; // 1597282685;
	blocktime: number; // 1597282685;
	firstSeenTime: number; // 1597282384;
	valueOut: number; // 1.49903978;
	size: number; // 1699;
	valueIn: number; // 1.49913978;
	fees: number; // 0.0001;
};
