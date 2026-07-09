import type { ChatAttachment, ChatFileAttachment, ChatImageAttachment, ChatImageMimeType } from '../simulator/types';
import { getAuthHeaders } from './client-runtime';

export const CHAT_IMAGE_MIME_TYPES = new Set<ChatImageMimeType>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const CHAT_IMAGE_MAX_COUNT = 4;
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_FILE_MAX_COUNT = 6;
export const CHAT_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const CHAT_FILE_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.csv', '.json', '.yaml', '.yml', '.xml', '.html',
  '.svg', '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.go', '.rs', '.sql', '.log', '.xls', '.xlsx',
];
export const CHAT_IMAGE_INPUT_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff',
];
export const CHAT_FILE_ACCEPT = CHAT_FILE_EXTENSIONS.join(',');
export const CHAT_IMAGE_ACCEPT = ['image/*', ...CHAT_IMAGE_INPUT_EXTENSIONS].join(',');
export const CHAT_ATTACHMENT_ACCEPT = [CHAT_IMAGE_ACCEPT, CHAT_FILE_ACCEPT].join(',');

export type ChatAttachmentUploadStatus = {
  imageCount: number;
  fileCount: number;
};

export function formatAttachmentBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatChatAttachmentUploadStatus(status: ChatAttachmentUploadStatus) {
  const imageCount = Math.max(0, status.imageCount);
  const fileCount = Math.max(0, status.fileCount);
  const parts: string[] = [];
  if (imageCount) parts.push(`${imageCount} 张图片`);
  if (fileCount) parts.push(`${fileCount} 个文件`);
  return `上传中 · ${parts.join(' / ') || '附件'}`;
}

export function getChatImageSrc(image: ChatImageAttachment): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function dataUrlPayload(dataUrl: string) {
  return dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
}

export function isSupportedChatFile(file: File) {
  const name = file.name.toLowerCase();
  return CHAT_FILE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function isLikelyChatImageFile(file: File) {
  const name = file.name.toLowerCase();
  return file.type.toLowerCase().startsWith('image/')
    || CHAT_IMAGE_INPUT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function uniqueChatImageFiles(files: File[]) {
  const seen = new Set<string>();
  return files.flatMap((file) => {
    if (!isLikelyChatImageFile(file)) return [];
    const key = `${file.name}:${file.type}:${file.size}:${file.lastModified || 0}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [file];
  });
}

export function splitChatUploadFiles(files: File[]) {
  const images: File[] = [];
  const filesOnly: File[] = [];
  for (const file of files) {
    if (isLikelyChatImageFile(file)) images.push(file);
    else filesOnly.push(file);
  }
  return { images, files: filesOnly };
}

export async function uploadChatImages(files: File[]): Promise<ChatImageAttachment[]> {
  if (!files.length) return [];
  const formData = new FormData();
  for (const file of files) formData.append('images', file, file.name || 'image');
  const response = await fetch('/api/chat/images/upload', {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  });
  const data = await response.json().catch(() => ({})) as { attachments?: ChatAttachment[]; error?: string };
  if (!response.ok) throw new Error(data.error || `图片上传失败: ${response.status}`);
  return (Array.isArray(data.attachments) ? data.attachments : [])
    .filter((item): item is ChatImageAttachment => item.type === 'image');
}

export async function fileToChatAttachment(file: File): Promise<ChatAttachment> {
  if (CHAT_IMAGE_MIME_TYPES.has(file.type as ChatImageMimeType)) {
    if (file.size > CHAT_IMAGE_MAX_BYTES) throw new Error('单张图片不能超过 5MB');
    const data = dataUrlPayload(await readFileDataUrl(file));
    if (!data) throw new Error('图片数据为空');
    return {
      id: crypto.randomUUID(),
      type: 'image',
      mediaType: file.type as ChatImageMimeType,
      data,
      name: file.name || 'image',
      size: file.size,
    } satisfies ChatImageAttachment;
  }

  if (!isSupportedChatFile(file)) throw new Error(`不支持这个文件类型: ${file.name}`);
  if (file.size > CHAT_FILE_MAX_BYTES) throw new Error(`单个文件不能超过 ${formatAttachmentBytes(CHAT_FILE_MAX_BYTES)}: ${file.name}`);
  const data = dataUrlPayload(await readFileDataUrl(file));
  if (!data) throw new Error('文件数据为空');
  return {
    id: crypto.randomUUID(),
    type: 'file',
    mediaType: file.type || 'application/octet-stream',
    data,
    name: file.name || 'file',
    size: file.size,
  } satisfies ChatFileAttachment;
}
