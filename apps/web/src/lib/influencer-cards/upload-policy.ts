/** Client-side early rejection only; API independently inspects actual bytes. */
export function validateCardAssetFile(file: Pick<File, 'name' | 'type' | 'size'>) {
  const extensions: Record<string, RegExp> = { 'image/png': /\.png$/i, 'image/jpeg': /\.jpe?g$/i, 'image/webp': /\.webp$/i };
  if (!extensions[file.type] || !extensions[file.type].test(file.name) || /[\\/\x00-\x1f]/.test(file.name)) throw Error('اسم الصورة أو نوعها غير مسموح؛ استخدم PNG أو JPG أو WebP مطابقاً للمحتوى');
  if (file.size <= 0 || file.size > 4 * 1024 * 1024) throw Error('حجم الصورة يجب أن يكون بين بايت واحد و4 ميغابايت');
}
