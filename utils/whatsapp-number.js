const DIGIT_TRANSLATION = new Map([
  ['٠', '0'], ['١', '1'], ['٢', '2'], ['٣', '3'], ['٤', '4'],
  ['٥', '5'], ['٦', '6'], ['٧', '7'], ['٨', '8'], ['٩', '9'],
  ['۰', '0'], ['۱', '1'], ['۲', '2'], ['۳', '3'], ['۴', '4'],
  ['۵', '5'], ['۶', '6'], ['۷', '7'], ['۸', '8'], ['۹', '9']
]);

export const toAsciiDigits = (value) => String(value || '')
  .replace(/[٠-٩۰-۹]/g, (digit) => DIGIT_TRANSLATION.get(digit) || digit);

/**
 * Convert a user-entered WhatsApp number into international digits-only form.
 * Afghanistan is the default for local mobile numbers because this installation
 * is used by the Paktika ISP database.
 */
export const normalizeWhatsAppNumber = (value, options = {}) => {
  const defaultCountryCode = String(options.defaultCountryCode || '93').replace(/\D/g, '');
  let input = toAsciiDigits(value).trim();

  input = input
    .replace(/^whatsapp:/i, '')
    .replace(/^https?:\/\/(?:api\.)?wa\.me\//i, '')
    .replace(/@(s\.whatsapp\.net|lid)$/i, '')
    .split('?')[0];

  let digits = input.replace(/\D/g, '');
  if (!digits) return '';

  // International dialling prefix.
  while (digits.startsWith('00')) digits = digits.slice(2);

  if (defaultCountryCode === '93') {
    // Common Afghanistan data-entry mistakes:
    // 093700123456 -> 93700123456
    // 930700123456 -> 93700123456
    // 9393700123456 -> 93700123456
    if (digits.startsWith('093') && digits.length >= 12) digits = digits.slice(1);
    if (digits.startsWith('9307') && digits.length === 12) digits = `93${digits.slice(3)}`;
    if (digits.startsWith('9393') && digits.length === 13) digits = digits.slice(2);

    // Local Afghanistan mobile formats: 0700123456 or 700123456.
    if (/^0?7\d{8}$/.test(digits)) {
      digits = `${defaultCountryCode}${digits.replace(/^0/, '')}`;
    }
  } else if (digits.startsWith('0') && defaultCountryCode) {
    digits = `${defaultCountryCode}${digits.replace(/^0+/, '')}`;
  }

  return digits;
};

export const isValidWhatsAppNumber = (value) => /^\d{10,15}$/.test(String(value || ''));
