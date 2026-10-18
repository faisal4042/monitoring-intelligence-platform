/** Prepared only. No seed, migrations, startup sync, maintenance, workers or provider calls. */
import {config} from '@mip/config';
import {assertReleaseEnvironment} from './startup/release-protection.js';
assertReleaseEnvironment(process.env,config);
process.env.MIP_STARTUP_PROFILE='release-preserve-data';
process.env.MIP_NEWS_READER='legacy'; // 0045 is excluded from this release.
await import('./server.js');
