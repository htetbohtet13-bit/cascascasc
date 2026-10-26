export function envValue(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return value;
  }
  return "";
}

export function paymentConfig() {
  return {
    apiKey: envValue("payment_secret", "PAYMENT_SECRET"),
    kbzReceiver: envValue("kbzreceiver", "KBZRECEIVER", "KBZ_RECEIVER"),
    waveReceiver: envValue("wavereceiver", "WAVERECEIVER", "WAVE_RECEIVER"),
    kbzName: envValue("kbzname", "KBZNAME", "KBZ_NAME"),
    waveName: envValue("wavename", "WAVENAME", "WAVE_NAME"),
    kbzPin: envValue("kbzpin", "KBZPIN", "KBZ_PIN"),
    wavePin: envValue("wavepin", "WAVEPIN", "WAVE_PIN"),
    apiUrl: (
      envValue("PAYMENT_API_URL", "payment_api_url") ||
      "https://one-cent.mmfastticket.com"
    ).replace(/\/$/, ""),
  };
}

export function paymentForwardHeaders() {
  const config = paymentConfig();
  return {
    "x-payment-key": config.apiKey,
    "x-kbz-receiver": config.kbzReceiver,
    "x-wave-receiver": config.waveReceiver,
    "x-kbz-name": config.kbzName,
    "x-wave-name": config.waveName,
    "x-kbz-pin": config.kbzPin,
    "x-wave-pin": config.wavePin,
    "x-payment-api-url": config.apiUrl,
  };
}
