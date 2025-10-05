// -------------------------------------
// -------------------------------------
import { Client } from '@notionhq/client';
import AWS from 'aws-sdk';
const s3 = new AWS.S3();

const response = {
    statusCode: 200,
    headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "OPTIONS,POST"
    },
    isBase64Encoded: false,
    body: JSON.stringify({ result: "Success" })
};

const notion = new Client({ auth: 'XXXXX' });

export const handler = async (event) => {
    try {
        console.log('Received event:', JSON.stringify(event, null, 2));
        
        // Check if event.body exists
        if (!event.body) {
            throw new Error('No request body received');
        }

        // Parse the body from API Gateway
        let body;
        try {
            body = JSON.parse(event.body);
            console.log(body)

        } catch (parseError) {
            console.error('Error parsing request body:', event.body);
            throw new Error('Invalid JSON in request body');
        }
        
        // logic to send more information to page in notion 

        function formatDate(date) {
                       return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
              }

        let now = new Date();
        let title = `Visita ${body.propiedad} - ${formatDate(now)}`;
        let comments = `Visita: ${body.submissionTimestamp} 
 Payload: ${JSON.stringify(body, null, 2)}`;
        
        const timestamps = Object.values(body.taskCompletionTimestamps)
            .filter(ts => ts !== null)
            .map(ts => new Date(ts));
        
        let timeClean = 0;
        if (timestamps.length > 0) {
            const firstTaskTime = new Date(Math.min(...timestamps));
            const submissionTime = new Date(body.submissionTimestamp);
            timeClean = Math.round((submissionTime - firstTaskTime) / (1000 * 60));
        }
        
        /*let caja = `Movimientos de caja: 
        \n Cambio de papel: ${body.changepaper} \n Descarga: ${body.downloadall} \n Foto: ${body.printmoneyfoto} \n Registro movimientos: ${body.registrarmovimientos} \n Monedas locales: ${body.monedaslocal} \n 
        Añadir hopper: ${body.addhopper} \n Cerrar caja: ${body.closecaja} \n monedas local: ${body.monedaslocal}.`;
            */

        console.log('Creating Notion page now...');
                    // Create Notion page
        const newPage = await notion.pages.create({
                        parent: {
                            database_id: '26c13ec8894180eb9802d73158977768'
                        },
                        icon: {
                            type: "emoji",
                            emoji: "🔨"
                        },
                        properties: {
                            visita: {
                                title: [
                                    {
                                        text: {
                                            content: title
                                        }
                                    }
                                ]
                            },
                            propiedad: {
                                select: {
                                    name: (() => {
                                        switch(body.propiedad) {
                                          case "usera": return "usera";
                                          case "hortaleza": return "hortaleza";
                                          default: return "otra";
                                        }
                                      })()
                                }
                            },
                            mcf_user: {
                                select: {
                                    name: (() => {
                                        switch(body.user) {
                                          case "lalo": return "lalo";
                                          case "adrian": return "adrian";
                                          case "oscar": return "oscar";
                                          case "kenia": return "kenia";
                                          default: return "otro";
                                        }
                                      })()
                                }    
                            },
                            visit_id: {
                                rich_text: [
                                    {
                                        text: {
                                            content: body.visitId || "no-id"
                                        }
                                    }
                                ]
                            },
                            superficies_secadoras: { checkbox: body.L99001 || false },
                            superficies_secadoras_atras: { checkbox: body.L99002 || false },
                            superficies_lavadoras: { checkbox: body.L99003 || false },
                            superficies_lavadoras_atras: { checkbox: body.L99004 || false },
                            tirar_botes: { checkbox: body.L99006 || false },
                            barrer: { checkbox: body.L99007 || false },
                            trapear: { checkbox: body.L99008 || false },
                            descarga_billetes: { checkbox: body.L99014 || false },
                            carga_monedas: { checkbox: body.L99015 || false },
                            carga_papel: { checkbox: body.L99012 || false },
                            carga_tarjetas_cliente: { checkbox: body.L99013 || false },
                            superficie_billetes: { checkbox: body.L99009 || false }, // Note: This
                            superficie_tarjetas: { checkbox: body.L99010 || false },
                            jabon_bodega: {
                                number: Number(body.L01020_1)+Number(body.L02020_1) || 0
                            },
                            suavizante_bodega: {
                                number: Number(body.L01020_2)+Number(body.L02020_2) || 0
                            },
                            oxigeno_bodega: {
                                number: Number(body.L01020_3)+Number(body.L02020_3) || 0
                            },
                            jabon_bombas: {
                                // bomba1 usera + bomba1 hortaleza +
                                // bomba2 usera + bomba2 hortaleza
                                number: Number(body.L01021_1)+Number(body.L02021_1)+ Number(body.L01022_1)+ Number(body.L02022_1) || 0
                            },
                            suavizante_bombas: {
                                number: Number(body.L01021_2)+Number(body.L02021_2)+ Number(body.L01022_2)+ Number(body.L02022_2)  || 0
                            },
                            oxigeno_bombas: {
                                number: Number(body.L01021_3)+Number(body.L02021_3)+ Number(body.L01022_3)+ Number(body.L02022_3)  || 0
                            },
                            time_clean: {
                                number: timeClean
                            },
                            limpieza_general: {
                                number: body.L99016 || 0
                            },
                            limpieza_maquinas: {
                                number: body.L99017 || 0
                            },
                            limpieza_basura: {
                                number: body.L99018 || 0
                            },
                            // limpieza_general: {
                            /*
                            jabon_maquina: {
                                number: Number(body.detergente_maquina) || 0
                            },
                            suavizante_maquina: {
                                number: Number(body.suavizante_maquina) || 0
                            },
                            oxigeno_maquina: {
                                number: Number(body.oxigeno_maquina) || 0
                            },
                            limpieza_inicial_general: {
                                number: Number(body.prev_clean_gen) || 0
                            },
                            limpieza_inicial_basura: {
                                number: Number(body.prev_clean_trash) || 0
                            },
                            limpieza_inicial_maquinas: {
                                number: Number(body.prev_clean_machines) || 0
                            },
                            caja_carga: {
                                checkbox: body.addhopper || false
                            },
                            caja_cerrar_fisico: {
                                checkbox: body.closecaja || false
                            },
                            rev_niveles: {
                                checkbox: body.revniveles || false
                            },
                            rev_bombas: {
                                checkbox: body.revbombas || false  
                            },
                            limpieza_superficies: {
                                checkbox: body.clean_superficie || false
                            },
                            tirar_botes: {
                                checkbox: body.tirar_botes || false
                            },
                            limpieza_basura: {
                                checkbox: body.clean_basura || false
                            }, 
                            caja_descarga: {
                                checkbox: body.downloadall || false
                            }, 
                            tpv_tarjetas_clean: {
                                checkbox: body.clean_tarjetas || false
                            }, 
                            tpv_billetes_clean: {
                                checkbox: body.clean_billetes || false
                            },
                            limpieza_superficie: {
                                checkbox: body.clean_superficie || false
                            },
                            barrer: {
                                checkbox: body.barrer || false
                            },
                            trapear: {
                                checkbox: body.trapear || false
                            },
                            vending: {
                                checkbox: body.vending || false
                            },
                            secadora_1_filtro: {
                                checkbox: body.filter_1 || false
                            },
                            secadora_2_filtro: {
                                checkbox: body.filter_2 || false
                            },
                            secadora_3_filtro: {
                                checkbox: body.filter_3 || false
                            },
                            secadora_4_filtro: {
                                checkbox: body.filter_4 || false
                            },
                            secadora_5_filtro: {
                                checkbox: body.filter_5 || false
                            },
                            secadora_6_filtro: {
                                checkbox: body.filter_6 || false
                            },
                            lavadora_1_restart: {
                                checkbox: body.restart_lav1 || false
                            },
                            lavadora_2_restart: {
                                checkbox: body.restart_lav2 || false
                            },
                            lavadora_3_restart: {
                                checkbox: body.restart_lav3 || false
                            },
                            lavadora_4_restart: {
                                checkbox: body.restart_lav4 || false
                            },
                            lavadora_5_restart: {
                                checkbox: body.restart_lav5 || false
                            },
                            lavadora_6_restart: {
                                checkbox: body.restart_lav6 || false
                            },
                            secadora_1_restart: {
                                checkbox: body.restart_sec1 || false
                            },
                            secadora_2_restart: {
                                checkbox: body.restart_sec2 || false
                            },
                            secadora_3_restart: {
                                checkbox: body.restart_sec3 || false
                            },
                            secadora_4_restart: {
                                checkbox: body.restart_sec4 || false
                            },
                            secadora_5_restart: {
                                checkbox: body.restart_sec5 || false
                            },
                            secadora_6_restart: {
                                checkbox: body.restart_sec6 || false
                            },
                            */
                            fecha: {
                                date: {
                                    start: formatDate(now)
                                }
                            }
                        }
                    }); 

         console.log(`Created page: ${newPage.id}`);

         /*
         // Add the description as a child block
         await notion.blocks.children.append({
            block_id: newPage.id,
            children: [
                {
                    "paragraph": {
                        "rich_text": [
                            {
                                "text": {
                                    "content": comments
                                }
                            }
                        ]
                    }
                }
            ],
        });
        */

console.log(`STARTING DATABASE`);

// Now create a database inside the new page using raw API call
const dbResponse = await fetch('https://api.notion.com/v1/databases', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer secret_vxCZixTbzZn3eZzyk7QivNp8Si6nd1BHaVixHoKPX7U`,
                'Content-Type': 'application/json',
                'Notion-Version': '2025-09-03'
            },
            body: JSON.stringify({
                parent: {
                    type: "page_id",
                    page_id: newPage.id
                },
                is_inline: true,
                title: [
                    {
                        type: "text",
                        text: {
                            content: `Tasks for ${title}`
                        }
                    }
                ],
                icon: {
                    type: "emoji",
                    emoji: "📊"
                },
                initial_data_source: {
                    properties: {
                        "Task": {
                            title: {}
                        },
                        "Status": {
                            select: {
                                options: [
                                    {
                                        name: "Pending",
                                        color: "yellow"
                                    },
                                    {
                                        name: "Complete",
                                        color: "green"
                                    }
                                ]
                            }
                        }, 
                        "Comments": {
                            rich_text: {}
                        }
                    }
                }
            })
        });

        const newDatabase = await dbResponse.json();

        if (!dbResponse.ok) {
            console.error('Database creation failed:', newDatabase);
            return {
                statusCode: 500,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    error: 'Failed to create database',
                    details: newDatabase
                })
            };
        }

        console.log(`Created database: ${newDatabase.id}`);

        const createTaskPage = async (databaseId, taskName, taskComment) => {
            try {
                await notion.pages.create({
                    parent: { database_id: databaseId },
                    properties: {
                        "Task": { // This should match the database property name
                            title: [
                                {
                                    text: {
                                        content: taskName,
                                    },
                                },
                            ],
                        },
                        "Status": {
                            select: {
                                name: "Complete"
                            }
                        }, 
                        "Comments": {
                            rich_text: [
                                {
                                    text: {
                                        content: taskComment
                                    }
                                }
                            ]
                        }
                    },
                });
                console.log(`Created page: ${taskName}`);
            } catch (error) {
                console.error(`Error creating page "${taskName}":`, error);
            }
        };

        const tasksToCreate = {
            // usera 
            "Usera - Reinicio Lavadora 4": {shouldCreate: body.L01001, comment: `Completed: ${body.taskCompletionTimestamps.L01001}` },
            "Usera - Reinicio Lavadora 5": {shouldCreate: body.L01002,  comment: `Completed: ${body.taskCompletionTimestamps.L01002}` },
            "Usera - Reinicio Lavadora 6": {shouldCreate: body.L01003, comment: `Completed: ${body.taskCompletionTimestamps.L01003}` },
            "Usera - Reinicio Lavadora 7": {shouldCreate: body.L01004, comment: `Completed: ${body.taskCompletionTimestamps.L01004}` },
            "Usera - Limpieza Filtro Secadora 1": {shouldCreate: body.L01009, comment: `Completed: ${body.taskCompletionTimestamps.L01009}` },
            "Usera - Limpieza Filtro Secadora 2": {shouldCreate: body.L01010, comment: `Completed: ${body.taskCompletionTimestamps.L01010}` },
            "Usera - Limpieza Filtro Secadora 3": {shouldCreate: body.L01011, comment: `Completed: ${body.taskCompletionTimestamps.L01011}` },
            "Usera - Revisión Bombas 1": {shouldCreate: body.L01007, comment: `Completed: ${body.taskCompletionTimestamps.L01007}` },
            "Usera - Revisión Bombas 2": {shouldCreate: body.L01008, comment: `Completed: ${body.taskCompletionTimestamps.L01008}` },
            // hortaleza
            "Hortaleza - Reinicio Lavadora 1": {shouldCreate: body.L02001, comment: `Completed: ${body.taskCompletionTimestamps.L02001}` },
            "Hortaleza - Reinicio Lavadora 2": {shouldCreate: body.L02002, comment: `Completed: ${body.taskCompletionTimestamps.L02002}` },
            "Hortaleza - Reinicio Lavadora 3": {shouldCreate: body.L02003, comment: `Completed: ${body.taskCompletionTimestamps.L02003}` },
            "Hortaleza - Reinicio Lavadora 4": {shouldCreate: body.L02004, comment: `Completed: ${body.taskCompletionTimestamps.L02004}` },
            "Hortaleza - Limpieza Filtro Secadora 5": {shouldCreate: body.L02011, comment: `Completed: ${body.taskCompletionTimestamps.L02011}` },
            "Hortaleza - Limpieza Filtro Secadora 6": {shouldCreate: body.L02009, comment: `Completed: ${body.taskCompletionTimestamps.L02009}` },
            "Hortaleza - Limpieza Filtro Secadora 7": {shouldCreate: body.L02010,  comment: `Completed: ${body.taskCompletionTimestamps.L02010}` },
            "Hortaleza - Revisión Bombas 1": {shouldCreate: body.L02007, comment: `Completed: ${body.taskCompletionTimestamps.L02007}` },
            "Hortaleza - Revisión Bombas 2": {shouldCreate: body.L02008, comment: `Completed: ${body.taskCompletionTimestamps.L02008}`}

        };

        for (const [taskName, { shouldCreate, comment }] of Object.entries(tasksToCreate)) {
            if (shouldCreate) {
                await createTaskPage(newDatabase.id, taskName, comment);
            }
        }

        function createLocationSpecificPayload(body) {
            // Common data for all locations
            const baseData = {
                visitId: body.visitId,
                location: body.propiedad,
                user: body.user,
                submissionTimestamp: body.submissionTimestamp,
                cleanlinessScores: {
                    general: body.L99016,
                    machines: body.L99017,
                    trash: body.L99018
                }
            };

            // L99 tasks (common to all locations)
            const commonTasks = {};
            const commonTimestamps = {};
            
            // Extract L99 tasks and their timestamps
            Object.keys(body).forEach(key => {
                if (key.startsWith('L99')) {
                    if (key.startsWith('L9901') || key.startsWith('L9902')) {
                        // Skip cleanliness scores, already captured above
                        return;
                    }
                    commonTasks[key] = body[key];
                    
                    // Get corresponding timestamp if it exists
                    if (body.taskCompletionTimestamps && body.taskCompletionTimestamps[key]) {
                        commonTimestamps[key] = body.taskCompletionTimestamps[key];
                    }
                }
            });

            // Location-specific tasks
            const locationTasks = {};
            const locationTimestamps = {};
            const locationPrefix = body.propiedad === 'usera' ? 'L01' : 'L02';
            
            Object.keys(body).forEach(key => {
                if (key.startsWith(locationPrefix)) {
                    locationTasks[key] = body[key];
                    
                    // Get corresponding timestamp if it exists
                    if (body.taskCompletionTimestamps && body.taskCompletionTimestamps[key]) {
                        locationTimestamps[key] = body.taskCompletionTimestamps[key];
                    }
                }
            });

            // Compile final payload
            const condensedPayload = {
                ...baseData,
                commonTasks,
                locationSpecificTasks: locationTasks,
                timestamps: {
                    common: commonTimestamps,
                    locationSpecific: locationTimestamps
                },
                summary: {
                    totalCommonTasks: Object.values(commonTasks).filter(Boolean).length,
                    totalLocationTasks: Object.values(locationTasks).filter(Boolean).length,
                    completedTasks: Object.keys({...commonTimestamps, ...locationTimestamps}).length
                }
            };

            return condensedPayload;
        }

        // Usage in your Lambda function:
        // Replace the current code block creation with:

        const condensedData = createLocationSpecificPayload(body);

        await notion.blocks.children.append({
            block_id: newPage.id,
            children: [{
                "type": "code",
                "code": {
                    "rich_text": [{
                        "type": "text",
                        "text": {
                            "content": JSON.stringify(condensedData, null, 2)
                        }
                    }],
                    "language": "json"
                }
            }]
        });

        console.log(`Condensed payload size: ${JSON.stringify(condensedData).length} characters`);
        

        // Return success response
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                success: true,
                pageId: newPage.id,
                databaseId: newDatabase.id,
                message: 'Page and database created successfully'
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
                error: "mcf-visits - Internal server error", 
                message: error.message 
            })
        };
    }
};
