/** Copy for the Account & balance settings section. */

/** Locale keys the Account & balance section reads. */
export type AccountSettingsKey =
  | 'nav'
  | 'signedIn'
  | 'signIn'
  | 'signOut'
  | 'cancel'
  | 'open'
  | 'initializing'
  | 'waiting'
  | 'completing'
  | 'expired'
  | 'failed'
  | 'profileUnavailable'
  | 'loading'
  | 'balance'
  | 'bonusBalance'
  | 'balanceSignedOut'
  | 'balanceUnavailable'
  | 'bonusEmpty'
  | 'usage'
  | 'topUp'
  | 'bonusNoticeTitle'
  | 'close'
  | 'signOutDescription'
  | 'signOutRunningDescription'
  | 'signOutUnknownDescription'

/** English copy. */
export const en: Record<AccountSettingsKey, string> = {
  nav: 'Account & balance',
  signedIn: 'Signed in to DeepSeek',
  signIn: 'Sign in',
  signOut: 'Sign out',
  cancel: 'Cancel',
  open: 'Open browser',
  initializing: 'Starting sign in…',
  waiting: 'Continue in your browser',
  completing: 'Completing sign in…',
  expired: 'Sign in expired. Try again.',
  failed: 'Could not complete the operation. Try again.',
  profileUnavailable: 'Account details are not available yet.',
  loading: 'Loading…',
  balance: 'Topped-up balance',
  bonusBalance: 'Granted balance',
  balanceSignedOut: 'Sign in to view',
  balanceUnavailable: 'View on Platform',
  bonusEmpty: 'No bonus available',
  usage: 'View usage',
  topUp: 'Top up',
  bonusNoticeTitle: 'Bonus credited',
  close: 'Close',
  signOutDescription: 'Signing out will not delete any data. You can sign in to this account again.',
  signOutRunningDescription: 'Tasks are currently running. Signing out will interrupt them. Sign out now?',
  signOutUnknownDescription:
    'Could not check running tasks. Signing out may interrupt tasks using this account. Sign out now?',
}

/** Simplified Chinese copy. */
export const zh: Record<AccountSettingsKey, string> = {
  nav: '账号与余额',
  signedIn: '已登录 DeepSeek',
  signIn: '登录',
  signOut: '退出登录',
  cancel: '取消',
  open: '打开浏览器',
  initializing: '正在发起登录…',
  waiting: '请在浏览器中继续',
  completing: '正在完成登录…',
  expired: '登录已过期，请重试。',
  failed: '操作未完成，请重试。',
  profileUnavailable: '账号资料暂不可用',
  loading: '加载中…',
  balance: '充值余额',
  bonusBalance: '赠金余额',
  balanceSignedOut: '登录后查看',
  balanceUnavailable: '前往开放平台查看',
  bonusEmpty: '暂无可用赠金',
  usage: '查询用量',
  topUp: '充值',
  bonusNoticeTitle: '赠金已到账',
  close: '关闭',
  signOutDescription: '退出登录不会丢失任何数据，你仍可以登录此账号。',
  signOutRunningDescription: '当前有进程正在执行中，点击“退出登录”，将会打断进程，是否即刻退出登录？',
  signOutUnknownDescription: '暂时无法确认任务状态。退出登录可能会中断使用此账号的任务，是否继续？',
}
