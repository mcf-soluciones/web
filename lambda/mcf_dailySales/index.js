const csv = require('csv-parse/sync');
const { createClient } = require('@libsql/client/web');
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const simpleParser = require('mailparser').simpleParser;

const turso = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

exports.handler = async (event) => {
    try {
        const s3Record = event.Records[0].s3;
        const bucketName = s3Record.bucket.name;
        const objectKey = decodeURIComponent(s3Record.object.key.replace(/\+/g, ' '));

        console.log('Processing file:', objectKey);

        // Get the file extension
        const fileExtension = objectKey.split('.').pop().toLowerCase();

        // Declare variables outside the if blocks
        let csvContent;
        let title;

        // Get the object from S3
        const s3Object = await s3.getObject({
            Bucket: bucketName,
            Key: objectKey
        }).promise();

        // Handle different file types
        if (fileExtension === 'csv') {
            console.log('Processing direct CSV file');
            csvContent = s3Object.Body.toString('utf-8');
            title = decodeURIComponent(objectKey).split('.')[0];

        } else if (['eml', 'msg', 'email'].includes(fileExtension)) {
            console.log('Processing email file');
            // Parse the email
            const parsedEmail = await simpleParser(s3Object.Body);

            // Find the CSV attachment
            const csvAttachment = parsedEmail.attachments.find(attachment =>
                attachment.filename.toLowerCase().endsWith('.csv')
            );

            if (!csvAttachment) {
                throw new Error('No CSV attachment found in email');
            }

            csvContent = csvAttachment.content.toString('utf-8');
            title = parsedEmail.subject || 'Ventas del día';
        } else {
            throw new Error(`Unsupported file type: ${fileExtension}`);
        }

        // Process CSV content
        const lines = csvContent.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        console.log('All CSV lines:', lines);

        // Find the total lines manually with more inclusive checks
        const totalLines = lines.filter(line =>
            line.toLowerCase().includes('total') &&
            (line.toLowerCase().includes('efectivo') ||
             line.toLowerCase().includes('bancaria') ||
             line.toLowerCase().includes('tarjeta'))
        );

        const dateNow = new Date().toISOString().slice(0,10)
        console.log('Found total lines:', totalLines);

        const mcfUser = objectKey.includes('_2215') ? 'local-usera' : 'local-hortaleza';
        console.log(`Using mcf_user: ${mcfUser}`);

        // Process each pattern
        for (const line of totalLines) {
            console.log('Processing line:', line);

            const parts = line.split(';').map(part => part.trim());
            let paymentType;
            let amount;

            // More flexible payment type detection
            if (line.toLowerCase().includes('efectivo')) {
                paymentType = 'cash';
            } else if (line.toLowerCase().includes('bancaria')) {
                paymentType = 'banco';
            } else if (line.toLowerCase().includes('tarjeta') || line.toLowerCase().includes('cliente')) {
                paymentType = 'tarjeta-cliente';
            }

            // Get the amount from the last non-empty part
            const amountStr = parts.filter(p => p).pop();
            amount = parseFloat(amountStr.replace(',', '.'));

            console.log(`Detected payment type: ${paymentType}, amount: ${amount}`);

            if (paymentType && !isNaN(amount)) {
                if (paymentType === 'tarjeta-cliente') {
                    console.log('Skipping row for tarjeta-cliente.');
                    continue;
                }

                console.log(`Inserting sale for ${paymentType} with amount ${amount}`);

                try {
                    await turso.execute({
                        sql: `INSERT INTO sales (movement, type, account, euros, mcf_user, date_real)
                              VALUES (?, 'venta', ?, ?, ?, ?)`,
                        args: [
                            `${title} [${paymentType}]`,
                            paymentType,
                            amount,
                            mcfUser,
                            dateNow,
                        ],
                    });

                    console.log(`Successfully inserted sale for ${paymentType}`);
                } catch (error) {
                    console.error(`Error inserting sale for ${paymentType}:`, error);
                }
            } else {
                console.warn(`Skipping line due to invalid payment type or amount: ${line}`);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Processing completed successfully',
                totalLinesProcessed: totalLines.length,
                linesProcessed: totalLines
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Error processing request',
                error: error.message,
                stack: error.stack
            })
        };
    }
};
