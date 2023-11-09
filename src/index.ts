import * as Sentry from '@sentry/node';

Sentry.init({
	dsn: 'sentry url here',
	tracesSampleRate: 1,
	profilesSampleRate: 1,
});

import './manager/manager';
import './telegram/telegram';
