// Netlify Function: server-side reCAPTCHA v2 verification
//
// IMPORTANT:
// Your reCAPTCHA SECRET KEY must NOT be placed here.
// Add it in Netlify Environment Variables as:
//
// RECAPTCHA_SECRET_KEY = your-secret-key
//
// The public SITE KEY is safe to use in index.html.

exports.handler = async (event) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: false,
        message: 'Method Not Allowed'
      })
    };
  }

  try {
    const body = JSON.parse(event.body || '{}');

    const token = String(body.token || '').trim();

    // Make sure the browser actually sent a CAPTCHA token
    if (!token) {
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          message: 'Missing reCAPTCHA response.'
        })
      };
    }

    // Secret key comes ONLY from Netlify Environment Variables
    const secret = process.env.RECAPTCHA_SECRET_KEY;

    if (!secret) {
      console.error(
        'RECAPTCHA_SECRET_KEY is not configured in Netlify.'
      );

      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          message: 'reCAPTCHA server verification is not configured.'
        })
      };
    }

    // Get visitor IP when available
    const forwardedFor =
      event.headers['x-forwarded-for'] || '';

    const remoteip =
      forwardedFor.split(',')[0].trim();

    // Send CAPTCHA token to Google's verification server
    const params = new URLSearchParams({
      secret: secret,
      response: token
    });

    if (remoteip) {
      params.set('remoteip', remoteip);
    }

    const verifyResponse = await fetch(
      'https://www.google.com/recaptcha/api/siteverify',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },
        body: params.toString()
      }
    );

    const result = await verifyResponse.json();

    // Allowed production hostname
    const allowedHosts = new Set([
      'eventpass.armancreations.in',
      'localhost'
    ]);

    const hostnameOk =
      !result.hostname ||
      allowedHosts.has(result.hostname);

    // CAPTCHA failed
    if (!result.success || !hostnameOk) {

      console.warn('reCAPTCHA rejected:', {
        success: result.success,
        hostname: result.hostname,
        errors: result['error-codes']
      });

      return {
        statusCode: 403,
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          success: false,
          message:
            'reCAPTCHA verification failed. Please complete the check again.'
        })
      };
    }

    // CAPTCHA successfully verified
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true
      })
    };

  } catch (error) {

    console.error(
      'reCAPTCHA verification error:',
      error
    );

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: false,
        message:
          'Unable to verify reCAPTCHA right now.'
      })
    };
  }
};
