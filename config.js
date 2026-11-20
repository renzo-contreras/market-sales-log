// Public settings for the app. Nothing secret goes in this file:
// the repo is public. The password lives only in Apps Script.
window.APP_CONFIG = {
  // Paste your Apps Script web app URL here (ends in /exec). See SETUP.md step 5.
  API_URL: 'https://script.google.com/macros/s/AKfycbxZm_s83xnNcYgSvzCcDqM5aLWdgCp2MEc4DUnbqLZzLCnuv2pUk3qiZTBOOn-N82vF/exec',

  // Shown on the printed report.
  SELLER_NAME: 'Renzo Contreras',
  MARKET_NAME: 'Mistletoe Market',

  // Market fee as a fraction of total sales (0.10 = 10%).
  FEE_RATE: 0.10,

  // How often (seconds) the app pulls new sales from the other device.
  REFRESH_SECONDS: 30,

  // Google reCAPTCHA "site key" (public, safe to share). The matching secret key
  // goes only in Apps Script Script Properties as RECAPTCHA_SECRET. See SETUP.md.
  // Leave empty to sign in without the captcha.
  RECAPTCHA_SITE_KEY: '6LfXSSouAAAAAKrOoPg172S9yeFpT-Mabrb9WUhv'
};
