/**
 * UI strings by locale. Expand keys as screens are translated.
 * Chat bots stay English until a separate channel i18n pass.
 */

import type { LocaleCode } from '../locale';

export type MessageKey = keyof typeof en;

const en = {
  // Auth
  'auth.signup.kicker': 'Get started',
  'auth.signup.title': 'Create your Flizy account',
  'auth.signup.blurb':
    'After signup the dashboard opens the Flizy bot on WhatsApp or Telegram with your link code filled in.',
  'auth.signup.step1': 'Account, @username, agent wallet',
  'auth.signup.step2': 'Set unlock PIN (required for lock/unlock)',
  'auth.signup.step3': 'Link chat + platforms (e.g. GitHub), claim holds',
  'auth.signup.displayName': 'Display name (optional)',
  'auth.signup.displayNameHint':
    'Any language — Korean, Chinese, etc. How we greet you. Not your @username.',
  'auth.signup.displayNamePh': 'How we greet you',
  'auth.signup.username': 'Username (required)',
  'auth.signup.usernamePh': 'letters and numbers only',
  'auth.signup.usernameHint':
    'Your Flizy name in payments (claimed by @you). a–z and 0–9 only. Change once every 30 days. Not used to route money.',
  'auth.signup.email': 'Email',
  'auth.signup.password': 'Password',
  'auth.signup.confirm': 'Retype password',
  'auth.signup.submit': 'Create account',
  'auth.signup.submitting': 'Creating account...',
  'auth.signup.hasAccount': 'Already have an account?',
  'auth.signup.login': 'Log in',
  'auth.signup.language': 'Language',

  'auth.login.kicker': 'Welcome back',
  'auth.login.title': 'Log in',
  'auth.login.blurb': 'Open your dashboard to manage trusted people, WhatsApp and Telegram.',
  'auth.login.email': 'Email',
  'auth.login.password': 'Password',
  'auth.login.submit': 'Sign in',
  'auth.login.submitting': 'Signing in...',
  'auth.login.newHere': 'New here?',
  'auth.login.create': 'Create an account',

  // Nav
  'nav.home': 'Home',
  'nav.wallet': 'Wallet',
  'nav.history': 'History',
  'nav.account': 'Account',
  'nav.swap': 'Swap',

  // Account profile / username / language
  'account.profile': 'Profile',
  'account.profileHelper':
    'Email, display name (any language), and Flizy @username (letters and numbers only).',
  'account.username': 'Username',
  'account.usernameHint':
    '3–24 characters, start with a letter, a–z and 0–9 only. Change at most once every 30 days.',
  'account.usernameCooldown': 'You can change your username again after {date}.',
  'account.usernameSave': 'Save',
  'account.usernameUpdate': 'Update',
  'account.usernameSaving': 'Saving…',
  'account.language': 'Language',
  'account.languageHelper':
    'UI language for this account. Chat bots stay English until channel translation ships.',
  'account.languageSave': 'Save language',
  'account.languageSaving': 'Saving…',
  'account.languageSaved': 'Language saved.',

  // Home slides
  'home.overview': 'Overview',
  'home.claims': 'Claims',
  'home.go': 'Go',
  'home.recent': 'Recent',
} as const;

const ko: Record<MessageKey, string> = {
  'auth.signup.kicker': '시작하기',
  'auth.signup.title': 'Flizy 계정 만들기',
  'auth.signup.blurb':
    '가입 후 대시보드에서 WhatsApp 또는 Telegram Flizy 봇을 링크 코드와 함께 열 수 있습니다.',
  'auth.signup.step1': '계정, @username, 에이전트 지갑',
  'auth.signup.step2': '잠금 해제 PIN 설정 (필수)',
  'auth.signup.step3': '채팅·플랫폼(예: GitHub) 연결 후 클레임',
  'auth.signup.displayName': '표시 이름 (선택)',
  'auth.signup.displayNameHint':
    '한국어·중국어 등 원하는 언어로. 인사에 쓰입니다. @username과 다릅니다.',
  'auth.signup.displayNamePh': '어떻게 부를까요',
  'auth.signup.username': '사용자 이름 (필수)',
  'auth.signup.usernamePh': '영문·숫자만',
  'auth.signup.usernameHint':
    '결제 알림에 표시 (claimed by @you). 영문·숫자만. 30일에 한 번 변경. 송금 경로에는 쓰이지 않습니다.',
  'auth.signup.email': '이메일',
  'auth.signup.password': '비밀번호',
  'auth.signup.confirm': '비밀번호 확인',
  'auth.signup.submit': '계정 만들기',
  'auth.signup.submitting': '만드는 중...',
  'auth.signup.hasAccount': '이미 계정이 있나요?',
  'auth.signup.login': '로그인',
  'auth.signup.language': '언어',

  'auth.login.kicker': '다시 오신 것을 환영합니다',
  'auth.login.title': '로그인',
  'auth.login.blurb': '대시보드에서 신뢰 주소, WhatsApp, Telegram을 관리하세요.',
  'auth.login.email': '이메일',
  'auth.login.password': '비밀번호',
  'auth.login.submit': '로그인',
  'auth.login.submitting': '로그인 중...',
  'auth.login.newHere': '처음이신가요?',
  'auth.login.create': '계정 만들기',

  'nav.home': '홈',
  'nav.wallet': '지갑',
  'nav.history': '기록',
  'nav.account': '계정',
  'nav.swap': '스왑',

  'account.profile': '프로필',
  'account.profileHelper':
    '이메일, 표시 이름(모든 언어), Flizy @username(영문·숫자만).',
  'account.username': '사용자 이름',
  'account.usernameHint':
    '3–24자, 영문으로 시작, a–z·0–9만. 30일에 한 번만 변경할 수 있습니다.',
  'account.usernameCooldown': '{date} 이후에 다시 변경할 수 있습니다.',
  'account.usernameSave': '저장',
  'account.usernameUpdate': '변경',
  'account.usernameSaving': '저장 중…',
  'account.language': '언어',
  'account.languageHelper':
    '이 계정의 화면 언어입니다. 채팅 봇은 채널 번역 전까지 영어입니다.',
  'account.languageSave': '언어 저장',
  'account.languageSaving': '저장 중…',
  'account.languageSaved': '언어가 저장되었습니다.',

  'home.overview': '개요',
  'home.claims': '클레임',
  'home.go': '바로가기',
  'home.recent': '최근',
};

const zh: Record<MessageKey, string> = {
  'auth.signup.kicker': '开始',
  'auth.signup.title': '创建 Flizy 账户',
  'auth.signup.blurb':
    '注册后可在控制台打开 WhatsApp 或 Telegram 的 Flizy 机器人，链接码已填好。',
  'auth.signup.step1': '账户、@username、代理钱包',
  'auth.signup.step2': '设置解锁 PIN（锁定/解锁必需）',
  'auth.signup.step3': '连接聊天与平台（如 GitHub），领取冻结资金',
  'auth.signup.displayName': '显示名称（可选）',
  'auth.signup.displayNameHint': '可用中文、韩文等任意语言，用于称呼。不是 @username。',
  'auth.signup.displayNamePh': '我们如何称呼你',
  'auth.signup.username': '用户名（必填）',
  'auth.signup.usernamePh': '仅英文字母和数字',
  'auth.signup.usernameHint':
    '支付通知中显示（claimed by @you）。仅 a–z、0–9。每 30 天可改一次。不用于路由资金。',
  'auth.signup.email': '邮箱',
  'auth.signup.password': '密码',
  'auth.signup.confirm': '再次输入密码',
  'auth.signup.submit': '创建账户',
  'auth.signup.submitting': '创建中...',
  'auth.signup.hasAccount': '已有账户？',
  'auth.signup.login': '登录',
  'auth.signup.language': '语言',

  'auth.login.kicker': '欢迎回来',
  'auth.login.title': '登录',
  'auth.login.blurb': '打开控制台管理信任地址、WhatsApp 与 Telegram。',
  'auth.login.email': '邮箱',
  'auth.login.password': '密码',
  'auth.login.submit': '登录',
  'auth.login.submitting': '登录中...',
  'auth.login.newHere': '新用户？',
  'auth.login.create': '创建账户',

  'nav.home': '首页',
  'nav.wallet': '钱包',
  'nav.history': '记录',
  'nav.account': '账户',
  'nav.swap': '兑换',

  'account.profile': '资料',
  'account.profileHelper': '邮箱、显示名（任意语言）与 Flizy @username（仅字母数字）。',
  'account.username': '用户名',
  'account.usernameHint': '3–24 位，以字母开头，仅 a–z、0–9。每 30 天最多改一次。',
  'account.usernameCooldown': '可在 {date} 之后再次修改用户名。',
  'account.usernameSave': '保存',
  'account.usernameUpdate': '更新',
  'account.usernameSaving': '保存中…',
  'account.language': '语言',
  'account.languageHelper': '本账户的界面语言。聊天机器人在频道翻译上线前仍为英语。',
  'account.languageSave': '保存语言',
  'account.languageSaving': '保存中…',
  'account.languageSaved': '语言已保存。',

  'home.overview': '概览',
  'home.claims': '待领',
  'home.go': '前往',
  'home.recent': '最近',
};

const TABLE: Record<LocaleCode, Record<MessageKey, string>> = {
  en: en as Record<MessageKey, string>,
  ko,
  zh,
};

export function t(locale: LocaleCode, key: MessageKey, vars?: Record<string, string>): string {
  let s = TABLE[locale]?.[key] ?? TABLE.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return s;
}

export { en };
