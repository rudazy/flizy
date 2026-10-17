// Stand-in for a Privy optional peer this app does not install.
// Importing it does nothing. Calling it throws.

function unavailable() {
  throw new Error('This Privy integration is not installed.');
}

module.exports = new Proxy(unavailable, {
  get() {
    return unavailable;
  },
});
