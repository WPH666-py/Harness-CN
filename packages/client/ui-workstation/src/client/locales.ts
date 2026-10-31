/**
 * `workstation` namespace dictionaries, and the namespace's declaration.
 *
 * The copy covers the empty tree, the empty editor, the waiting states, the
 * failure lines, and the tab strip's own labels. The failure lines take the
 * endpoint's own message because the codes it can answer with — a path that is
 * gone, one outside the workspace, a file that is not text — are told apart
 * here already by which pane failed.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'workstation'>` or `PropsLocale<'workstation'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Toggle labels, tree states, tab labels, editor states, and failure lines. */
    workstation: WorkstationKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'toggle.mode': 'IDE/工作站',
  'toggle.enable': '切换到 IDE 布局',
  'toggle.disable': '回到对话布局',
  'tree.root': '工作区',
  'tree.loading': '正在读取…',
  'tree.empty': '空目录',
  'tree.truncated': '条目太多，只显示了一部分。',
  'tree.failed': '无法读取这个目录：{message}',
  'viewer.empty': '从左侧选择一个文件。',
  'viewer.loading': '正在读取文件…',
  'viewer.failed': '无法读取这个文件：{message}',
  'tab.unsaved': '已修改',
  'tab.save': '保存',
  'tab.closeSave': '关闭并保存',
  'tab.saveFailed': '保存失败：{message}',
  'editor.label': '编辑 {name}',
  'preview.image': '图片预览',
  'preview.size': '大小 {size}',
  'session.none': '选择会话后可用。',
} satisfies Record<string, string>

/** Every key the namespace carries, taken from the source-of-truth dictionary. */
export type WorkstationKey = keyof typeof zh

/** English dictionary, complete against the key set. */
export const en = {
  'toggle.mode': 'IDE / Workstation',
  'toggle.enable': 'Switch to the IDE layout',
  'toggle.disable': 'Back to the conversation layout',
  'tree.root': 'Workspace',
  'tree.loading': 'Reading…',
  'tree.empty': 'Empty directory',
  'tree.truncated': 'Too many entries; only some are shown.',
  'tree.failed': 'Could not read this directory: {message}',
  'viewer.empty': 'Select a file on the left.',
  'viewer.loading': 'Reading file…',
  'viewer.failed': 'Could not read this file: {message}',
  'tab.unsaved': 'Unsaved',
  'tab.save': 'Save',
  'tab.closeSave': 'Close and save',
  'tab.saveFailed': 'Save failed: {message}',
  'editor.label': 'Editing {name}',
  'preview.image': 'Image preview',
  'preview.size': 'Size {size}',
  'session.none': 'Available once a Session is selected.',
} satisfies Record<WorkstationKey, string>
