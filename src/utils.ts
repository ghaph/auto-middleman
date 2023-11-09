import readline from 'readline';

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

export async function question(question: string) {
	return new Promise<string>((resolve) => {
		rl.question(question, (answer) => {
			resolve(answer);
		});
	});
}

export function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// add commas
export function commaNumber(numb: string | number) {
	return numb.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function snakeToTitleCase(str: string) {
	if (str.length <= 3) {
		return str.toUpperCase();
	}

	return str
		.split(str.includes('_') ? '_' : '/')
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

export function convertToLookalike(str: string, chance: number): string {
	const lookalikeMap: { [key: string]: string } = {
		A: '\u0410', // Latin 'A' to Cyrillic 'А'
		a: '\u0430', // Latin 'a' to Cyrillic 'а'
		B: '\u0412', // Latin 'B' to Cyrillic 'В'
		C: '\u0421', // Latin 'C' to Cyrillic 'С'
		c: '\u0441', // Latin 'c' to Cyrillic 'с'
		E: '\u0415', // Latin 'E' to Cyrillic 'Е'
		e: '\u0435', // Latin 'e' to Cyrillic 'е'
		H: '\u041D', // Latin 'H' to Cyrillic 'Н'
		I: '\u0406', // Latin 'I' to Cyrillic 'І'
		i: '\u0456', // Latin 'i' to Cyrillic 'і'
		J: '\u0408', // Latin 'J' to Cyrillic 'Ј'
		j: '\u0458', // Latin 'j' to Cyrillic 'ј'
		K: '\u041A', // Latin 'K' to Cyrillic 'К'
		M: '\u041C', // Latin 'M' to Cyrillic 'М'
		O: '\u041E', // Latin 'O' to Cyrillic 'О'
		o: '\u043E', // Latin 'o' to Cyrillic 'о'
		P: '\u0420', // Latin 'P' to Cyrillic 'Р'
		p: '\u0440', // Latin 'p' to Cyrillic 'р'
		T: '\u0422', // Latin 'T' to Cyrillic 'Т'
		X: '\u0425', // Latin 'X' to Cyrillic 'Х'
		x: '\u0445', // Latin 'x' to Cyrillic 'х'
		y: '\u0443', // Latin 'y' to Cyrillic 'у'
	};

	let convertedStr = '';
	for (let char of str) {
		const rand = Math.random();
		if (rand > chance) {
			convertedStr += char;
			continue;
		}

		convertedStr += lookalikeMap[char] || char; // If no lookalike is found, keep the original char
	}
	return convertedStr;
}

// factor is a number between -1 and 1, 1 is completely darkened
export function darkenColor(decimalColor: number, factor: number) {
	// Parse the decimal color into its RGB components
	const r = (decimalColor >> 16) & 255;
	const g = (decimalColor >> 8) & 255;
	const b = decimalColor & 255;

	// Calculate the darkened values for each component
	const darkenedR = Math.min(Math.max(0, Math.floor(r - r * factor)), 255);
	const darkenedG = Math.min(Math.max(0, Math.floor(g - g * factor)), 255);
	const darkenedB = Math.min(Math.max(0, Math.floor(b - b * factor)), 255);

	// Combine the darkened components into a new decimal color
	const darkenedDecimalColor = (darkenedR << 16) | (darkenedG << 8) | darkenedB;

	return darkenedDecimalColor;
}

export function parseTimeToMillisecons(timeString: string): number {
	const timeRegex = /^(\d+)([dhmw])$/;
	const match = timeString.match(timeRegex);

	if (!match) {
		throw new Error('Invalid time string format');
	}

	const value = parseInt(match[1]);
	const unit = match[2];

	switch (unit) {
		case 'd':
			return value * 24 * 60 * 60 * 1000; // days to milliseconds
		case 'h':
			return value * 60 * 60 * 1000; // hours to milliseconds
		case 'm':
			return value * 60 * 1000; // minutes to milliseconds
		case 'w':
			return value * 7 * 24 * 60 * 60 * 1000; // weeks to milliseconds
		default:
			throw new Error('Invalid time unit');
	}
}

export function isValidAddress(address: string): boolean {
	return !(address.length < 20 || address.includes(' ') || address.length > 100);
}

export function isAllDigits(str: string): boolean {
	return /^\d+$/.test(str);
}
