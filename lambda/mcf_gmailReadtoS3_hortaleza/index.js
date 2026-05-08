const {google} = require('googleapis');
const AWS = require('aws-sdk');

exports.handler = async (event, context) => {
  try {
    // Initialize AWS S3
    const s3 = new AWS.S3();
    
    // Get service account credentials from Secrets Manager
    const secretsManager = new AWS.SecretsManager();
    const secretData = await secretsManager.getSecretValue({ SecretId: 'GmailServiceAccount' }).promise();
    const serviceAccountKey = JSON.parse(secretData.SecretString);

    // Create JWT client
    const jwtClient = new google.auth.JWT(
      serviceAccountKey.client_email,
      null,
      serviceAccountKey.private_key,
      ['https://www.googleapis.com/auth/gmail.readonly'],
      'eduardo@enelmargen.org'  // Replace with your Workspace email
    );

    await jwtClient.authorize();

    const gmail = google.gmail({
      version: 'v1',
      auth: jwtClient
    });

    const date = new Date();
    date.setDate(date.getDate() - 2);
    console.log(date.toISOString().slice(0,10).toString());

    

    // Search parameters
    const searchQuery = `subject:"Fichero de ventas del" has:attachment from:speedqueencanillas@gmail.com`; // Adjust as needed

    console.log(searchQuery)

    const response = await gmail.users.messages.list({
      userId: 'eduardo@enelmargen.org',
      q: searchQuery
    });

    if (!response.data.messages || response.data.messages.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'No matching emails with CSV attachments found' })
      };
    }

    // Get the first matching message
    const message = await gmail.users.messages.get({
      userId: 'eduardo@enelmargen.org',
      id: response.data.messages[0].id,
      format: 'full'
    });

    // Find CSV attachment
    const csvAttachment = message.data.payload.parts?.find(part => 
      part.filename?.toLowerCase().endsWith('.csv') && part.body.attachmentId
    );

    if (!csvAttachment) {
      return {
        statusCode: 404,
        body: JSON.stringify({ message: 'No CSV attachment found in the email' })
      };
    }

    // Get attachment content
    const attachment = await gmail.users.messages.attachments.get({
      userId: 'eduardo@enelmargen.org',
      messageId: message.data.id,
      id: csvAttachment.body.attachmentId
    });

    // Convert base64 data
    const fileData = Buffer.from(attachment.data.data, 'base64');

    // Generate timestamp for unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${csvAttachment.filename}`;

    // wait to avoid race condition with usera
    await new Promise(resolve => setTimeout(resolve, 5000)); 

    // Upload to S3
    await s3.putObject({
      Bucket: 'mcf-sales',
      Key: `${filename}`,
      Body: fileData,
      ContentType: 'text/csv'
    }).promise();

    // Get email date for reference
    const headers = message.data.payload.headers;
    const emailDate = headers.find(h => h.name === 'Date')?.value;

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'CSV file processed successfully',
        details: {
          emailDate: emailDate,
          originalFilename: csvAttachment.filename,
          s3Location: `s3://mcf-sales/${filename}`
        }
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
