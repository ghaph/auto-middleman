import BigNumber from 'bignumber.js';
import { ethers, Overrides } from 'ethers';

import { newPromiEvent, PromiEvent } from '../../lib/promiEvent';
import { Asset, Handler } from '../../types/types';
import { getEndpoint, getEthersSigner, getNetwork, getTransactionConfig, Network } from './ethUtils';
import { Deferrable } from 'ethers/lib/utils';
import { TransactionRequest } from '@ethersproject/abstract-provider';

interface ConstructorOptions {
	infuraKey?: string;
	ethereumNode?: string;
}
interface AddressOptions {}
interface BalanceOptions extends AddressOptions {
	address?: string;

	// Note that this acts differently to BTC/BCH/ZEC. This returns the balance
	// (confirmations - 1) blocks ago.
	confirmations?: number; // defaults to 0
}
interface TxOptions extends Overrides {
	subtractFee?: boolean; // defaults to false
}

export class ETHHandler implements Handler<ConstructorOptions, AddressOptions, BalanceOptions, TxOptions> {
	private readonly privateKey: string;
	private readonly network: Network;

	private readonly decimals = 18;

	private readonly unlockedAddress: string;

	private readonly sharedState: {
		ethSigner: ethers.Signer;
	};

	constructor(privateKey: string, network: string, options?: ConstructorOptions, sharedState?: any) {
		this.network = getNetwork(network);
		this.privateKey = privateKey;
		const [ethSigner, address] = getEthersSigner(this.privateKey, getEndpoint(this.network, options && options.ethereumNode, options && options.infuraKey));
		this.unlockedAddress = address;
		sharedState.ethSigner = ethSigner;
		this.sharedState = sharedState;
	}

	// Returns whether or not this can handle the asset
	public readonly handlesAsset = (asset: Asset): boolean => typeof asset === 'string' && ['ETH', 'ETHER', 'ETHEREUM'].indexOf(asset.toUpperCase()) !== -1;

	public readonly address = (asset: Asset, options?: AddressOptions): string => this.unlockedAddress;

	// Balance
	public readonly getBalance = async (asset: Asset, options?: BalanceOptions): Promise<BigNumber> => (await this.getBalanceInSats(asset, options)).dividedBy(new BigNumber(10).exponentiatedBy(this.decimals));

	public readonly getBalanceInSats = async (asset: Asset, options?: BalanceOptions): Promise<BigNumber> => {
		let atBlock;
		if (options && options.confirmations && options.confirmations > 0) {
			const currentBlock = new BigNumber(await this.sharedState.ethSigner.provider!.getBlockNumber());
			atBlock = currentBlock.minus(options.confirmations).plus(1).toNumber();
		}
		const address = (options && options.address) || this.address(asset);
		return new BigNumber((await this.sharedState.ethSigner.provider!.getBalance(address, atBlock)).toString());
	};

	// Transfer
	public readonly send = (to: string, value: BigNumber, asset: Asset, options?: TxOptions): PromiEvent<string> => this.sendSats(to, value.times(new BigNumber(10).exponentiatedBy(this.decimals)), asset, options);

	public readonly sendSats = (to: string, valueIn: BigNumber, asset: Asset, optionsIn?: TxOptions): PromiEvent<string> => {
		const promiEvent = newPromiEvent<string>();

		(async () => {
			const options = optionsIn || {};

			let value = valueIn;

			const txOptions = getTransactionConfig(options);

			const sendOptions: Deferrable<TransactionRequest> = {
				gasLimit: txOptions.gasLimit || 21000,
				from: this.address(asset),
				...txOptions,
				to,
			};

			if (options.subtractFee) {
				sendOptions.gasPrice = txOptions.gasPrice || (await this.sharedState.ethSigner.provider!.getGasPrice());
				const gasPriceBN = new BigNumber(sendOptions.gasPrice.toString());

				const fee = gasPriceBN.times(new BigNumber((sendOptions.gasLimit as any).toString()));

				//console.log(sendOptions.gasPrice, sendOptions.gasLimit, fee.toString());

				if (fee.gt(value)) {
					throw new Error(`Unable to include fee in value, fee exceeds value (${fee.toFixed()} > ${value.toFixed()})`);
				}

				if (fee.lte(0)) {
					throw new Error('Invalid fee: ' + fee.toString());
				}

				value = value.minus(fee);
			}

			sendOptions.value = value.toFixed();
			const tx = await this.sharedState.ethSigner.sendTransaction(sendOptions);
			promiEvent.emit('transactionHash', tx.hash);
			await tx.wait();
			promiEvent.resolve(tx.hash);
		})().catch((error) => {
			promiEvent.reject(error);
		});

		return promiEvent;
	};
}
