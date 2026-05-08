const { google } = require('googleapis');
const gmail = google.gmail('v1');
const AWS = require('aws-sdk'); // This will work in Lambda without installing it

// Create function to encode the email in base64
function makeBody(to, from, subject, message) {
    const str = [
        'Content-Type: text/plain; charset="UTF-8"\n',
        'MIME-Version: 1.0\n',
        'Content-Transfer-Encoding: 7bit\n',
        'to: ', to, '\n',
        'from: ', from, '\n',
        'subject: ', subject, '\n\n',
        message
    ].join('');

    return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

exports.handler = async (event) => {
    try {
        // Move Secrets Manager initialization and call inside the handler
        const secretsManager = new AWS.SecretsManager();
        const secretData = await secretsManager.getSecretValue({ SecretId: 'GmailServiceAccount' }).promise();
        const serviceAccountKey = JSON.parse(secretData.SecretString);

        // Create JWT client
        const auth = new google.auth.JWT(
            serviceAccountKey.client_email,
            null,
            serviceAccountKey.private_key,
            ['https://www.googleapis.com/auth/gmail.send'],
            'eduardo@enelmargen.org'
        );

        // Create email
        const emailTo = 'mcf.usera@gmail.com';
        const emailFrom = 'gmail-lambda-service@western-evening-264012.iam.gserviceaccount.com';
        const subject = '[Usera] Compu Prendida';
        const message = `Estoy Ok.`;

        // Encode email
        const raw = makeBody(emailTo, emailFrom, subject, message);

        // Send email
        const result = await gmail.users.messages.send({
            auth: auth,
            userId: 'me',
            requestBody: {
                raw: raw
            }
        });

        console.log('Email sent successfully:', result.data);
        
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'OK!' })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to send email', details: error.message })
        };
    }
};
