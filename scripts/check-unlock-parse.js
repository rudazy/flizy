const p = require('../lib/prefix');
console.log('unlock alone', p.parseUnlockCommand('unlock'));
console.log('unlock secret', p.parseUnlockCommand('unlock mypass'));
console.log('lock', p.parseLockCommand('lock'));
