/**
 * `sidebarFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the tree could not list, one code each, because a
 * directory that is gone, one outside the workspace, and a path that is not a
 * directory each suggest a different next step. The gesture lines do the same
 * for what the reader asked the tree to change: a destination already taken and
 * a directory that still holds something each say what was left alone, and an
 * entry that went away in the meantime says so rather than repeating a failure
 * the reader cannot act on.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarFiles'>` or `PropsLocale<'sidebarFiles'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  newFile: '新建文件',
  newFolder: '新建文件夹',
  paste: '粘贴',
  'menu.open': '打开',
  'menu.copy': '复制',
  'menu.cut': '剪切',
  'menu.paste': '粘贴',
  'menu.delete': '删除',
  'draft.nameFile': '文件名',
  'draft.nameFolder': '文件夹名',
  'confirm.title': '确认删除',
  'confirm.file': '将删除“{name}”。',
  'confirm.directory': '将删除“{name}”及其全部内容。',
  'confirm.action': '删除',
  cancel: '取消',
  'toggle.label': '工作区文件',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
  'gesture.exists': '目标位置已经有同名条目，这里不会覆盖。',
  'gesture.notEmpty': '这个目录里还有内容，没有删除。',
  'gesture.gone': '它已经不在了。可能已被移动或删除。',
  'gesture.failed': '操作失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no workspace directory.',
  reload: 'Reload',
  newFile: 'New file',
  newFolder: 'New folder',
  paste: 'Paste',
  'menu.open': 'Open',
  'menu.copy': 'Copy',
  'menu.cut': 'Cut',
  'menu.paste': 'Paste',
  'menu.delete': 'Delete',
  'draft.nameFile': 'File name',
  'draft.nameFolder': 'Folder name',
  'confirm.title': 'Confirm deletion',
  'confirm.file': 'Deletes "{name}".',
  'confirm.directory': 'Deletes "{name}" and everything inside it.',
  'confirm.action': 'Delete',
  cancel: 'Cancel',
  'toggle.label': 'Workspace files',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
  'error.unavailable': 'Read failed: {message}',
  'gesture.exists': 'An entry with that name is already at the destination, so nothing was overwritten.',
  'gesture.notEmpty': 'That directory still holds something, so it was not deleted.',
  'gesture.gone': 'It is gone now. It may have been moved or deleted.',
  'gesture.failed': 'That action failed: {message}',
} satisfies Record<SidebarFilesKey, string>
