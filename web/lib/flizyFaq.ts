/**
 * Product FAQ — must match visible copy on the guide (and FAQ JSON-LD).
 * Token-launch questions wait until that product surface ships.
 */

export const FLIZY_FAQ: Array<{ question: string; answer: string }> = [
  {
    question: 'What is Flizy?',
    answer:
      'Flizy is a chat wallet for WhatsApp and Telegram. You manage trusted destinations and unlock PIN on the website, then send crypto from chat. One account works on both apps.',
  },
  {
    question: 'How do I send crypto from WhatsApp or Telegram?',
    answer:
      'Create a free account on flizy.app, fund your Flizy wallet, add trusted people on the dashboard, link the chat with a one-time code, then send with flizy send (WhatsApp) or /send (Telegram) and confirm.',
  },
  {
    question: 'Who can I pay?',
    answer:
      'A Flizy username or pay code, or a phone number, email, GitHub or X handle, even before the person joins. Unclaimed money waits, and you can cancel it from chat. A raw wallet address only works once you have saved it on the site with your password, and a new one waits 24 hours before it can receive.',
  },
  {
    question: 'How do I send to a phone number?',
    answer:
      'Use the international format, for example flizy send 0.01 ETH to +234 708 043 7343. Spaces and dashes are fine. A number without a country code is not guessed. You can pick one country when you sign up, on Account, or in chat with country korea. That choice is optional and you can change it anytime. With Korea saved, 10 1234 5678 is sent as +82 10 1234 5678. On the website the country is selected for you, and Flizy stores the number in one form.',
  },
  {
    question: 'How do phone claims work?',
    answer:
      'If someone sends to your phone number, the funds sit in escrow until you claim. Phone holds show on the web dashboard, but you claim only in WhatsApp or Telegram after that number is proven on that chat (flizy claim).',
  },
  {
    question: 'How do I unlink WhatsApp or Telegram?',
    answer:
      'In chat send flizy unlink (or /unlink on Telegram). On the site go to Account → Chat, enter your password, and Unlink. Unlinking drops phone proof for that app until you link again.',
  },
  {
    question: 'What chains does Flizy support?',
    answer:
      'Flizy is GIWA-first on EVM. The site and bots use the configured default chain (see the dashboard for the live network and deposit address).',
  },
  {
    question: 'How do I get test ETH for Flizy?',
    answer:
      'Copy your Flizy wallet address from the dashboard (Wallet → Fund), open the official GIWA faucet at https://faucet.giwa.io, paste that address, and request funds. No bridge or separate MetaMask step is required for the faucet.',
  },
  {
    question: 'Is Flizy free to start?',
    answer:
      'Creating an account is free. You need gas and balance on the supported chain to send. Trading FLZ on the built-in DEX may include protocol fees shown in the quote before you confirm.',
  },
];
