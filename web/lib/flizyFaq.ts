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
      'Create a free account on flizy.app, fund your agent wallet, add trusted people on the dashboard, link the chat with a one-time code, then send with flizy send (WhatsApp) or /send (Telegram) and confirm.',
  },
  {
    question: 'Why only trusted addresses?',
    answer:
      'Flizy only pays destinations you already saved on the site. That way a stolen phone cannot invent a new recipient. Manage the list under Account → Trusted.',
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
    question: 'Is Flizy free to start?',
    answer:
      'Creating an account is free. You need gas and balance on the supported chain to send. Trading FLZ on the built-in DEX may include protocol fees shown in the quote before you confirm.',
  },
];
