// Lambda function for writing gastos to Google Sheets
// Deploy this as a new Lambda function with API Gateway endpoint: /gastos

const { google } = require('googleapis');
const AWS = require('aws-sdk');

// Google Sheets configuration
const SPREADSHEET_ID = '1wju-dUlIOAA8qFbMX2roH0YcinsbqrXWgjSSNNyN0qs';
const SHEET_NAME = 'gastos';

const secretsManager = new AWS.SecretsManager();

// Cache for service account key (to avoid fetching on every invocation)
let serviceAccountKey = null;

async function getServiceAccountKey() {
    if (serviceAccountKey) {
        return serviceAccountKey;
    }
    const secretData = await secretsManager.getSecretValue({ SecretId: 'GmailServiceAccount' }).promise();
    serviceAccountKey = JSON.parse(secretData.SecretString);
    return serviceAccountKey;
}

exports.handler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));

        // Handle OPTIONS preflight request
        if (event.httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type",
                    "Access-Control-Allow-Methods": "OPTIONS,POST"
                },
                body: ''
            };
        }

        // Check if event.body exists
        if (!event.body) {
            throw new Error('No request body received');
        }

        // Parse the body from API Gateway
        let body;
        try {
            body = JSON.parse(event.body);
            console.log('Parsed body:', body);
        } catch (parseError) {
            console.error('Error parsing request body:', event.body);
            throw new Error('Invalid JSON in request body');
        }

        // Get service account credentials from Secrets Manager
        const credentials = await getServiceAccountKey();

        // Initialize Google Sheets API
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: credentials.client_email,
                private_key: credentials.private_key,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const sheets = google.sheets({ version: 'v4', auth });

        // Format date components
        const now = new Date(body.fecha || new Date());
        const yyyy = now.getFullYear();
        const mm = now.getMonth() + 1; // JavaScript months are 0-indexed
        const fecha = `${yyyy}-${String(mm).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        // Generate unique ID
        const id = `G-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        // Prepare row data matching the spreadsheet columns:
        // id | yyyy | mm | fecha | propiedad | concepto_mcf | cuenta_mcf | concepto_proveedor |
        // nif_proveedor | razon_social | num_factura | is_fiscal | pagado_por | importe_total |
        // importe_iva | base_imponible | importe_irpf | importe_otros | currency | factura |
        // concepto_banco | es_inversion

        const rowData = [
            id,                                          // id
            yyyy,                                        // yyyy
            mm,                                          // mm
            fecha,                                       // fecha
            body.propiedad || null,                      // propiedad
            body.concepto_mcf || null,                   // concepto_mcf
            body.cuenta_mcf || null,                     // cuenta_mcf
            body.concepto_proveedor || null,             // concepto_proveedor
            body.nif_proveedor || null,                  // nif_proveedor
            body.razon_social || null,                   // razon_social
            body.num_factura || null,                    // num_factura
            body.is_fiscal ? 'Si' : 'No',                // is_fiscal
            body.mcf_user || null,                       // pagado_por
            body.importe_total || 0,                     // importe_total
            body.importe_iva || null,                    // importe_iva
            body.base_imponible || null,                 // base_imponible
            body.importe_irpf || null,                   // importe_irpf
            body.importe_otros || null,                  // importe_otros
            body.currency || 'EUR',                      // currency
            body.factura || null,                        // factura
            body.concepto_banco || null,                 // concepto_banco
            body.es_inversion ? 'Si' : 'No'              // es_inversion
        ];

        console.log('Row data to append:', rowData);

        // Append row to spreadsheet
        const appendResult = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${SHEET_NAME}!A:V`, // Columns A through V (22 columns)
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [rowData]
            }
        });

        console.log('Append result:', appendResult.data);

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "OPTIONS,POST"
            },
            body: JSON.stringify({
                success: true,
                message: 'Gasto added to Google Sheets successfully',
                id: id,
                updatedRange: appendResult.data.updates?.updatedRange
            })
        };

    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Access-Control-Allow-Methods": "OPTIONS,POST"
            },
            body: JSON.stringify({
                error: "mcf-gastos-sheets - Internal server error",
                message: error.message
            })
        };
    }
};
