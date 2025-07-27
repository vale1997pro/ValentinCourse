// server.js - Sistema completo con Google Meet, email eleganti, Google Sheets e Keep-Alive per Render
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== KEEP-ALIVE SYSTEM FOR RENDER =====
// Pulisce RENDER_URL se contiene il prefisso della variabile
let RENDER_URL = process.env.RENDER_URL || `http://localhost:${PORT}`;
if (RENDER_URL.startsWith('RENDER_URL=')) {
    RENDER_URL = RENDER_URL.replace('RENDER_URL=', '');
    console.log('⚠️ RENDER_URL conteneva il prefisso della variabile, rimosso automaticamente');
}

// Ping endpoint per keep-alive
app.get('/ping', (req, res) => {
    res.status(200).json({
        status: 'pong',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        environment: process.env.NODE_ENV || 'development',
        keepAliveActive: process.env.NODE_ENV === 'production'
    });
});

// Keep-alive function con migliore gestione errori
async function keepServerAlive() {
    if (process.env.NODE_ENV === 'production' && RENDER_URL && !RENDER_URL.includes('localhost')) {
        try {
            const response = await fetch(`${RENDER_URL}/ping`);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            console.log(`🏓 Keep-alive ping successful: ${data.status} at ${data.timestamp} (uptime: ${Math.floor(data.uptime)}s)`);

        } catch (error) {
            console.error(`❌ Keep-alive ping failed: ${error.message}`);

            // Retry dopo 2 minuti se fallisce
            setTimeout(() => {
                console.log('🔄 Retry keep-alive ping...');
                keepServerAlive();
            }, 2 * 60 * 1000); // 2 minuti
        }
    } else {
        console.log('🏓 Keep-alive skipped (not in production or RENDER_URL not set)');
    }
}

// ✅ FIXED: Sistema keep-alive migliorato
if (process.env.NODE_ENV === 'production') {
    console.log('🔄 Configurando keep-alive per Render (ogni 12 minuti)...');
    console.log(`🌐 RENDER_URL configurato: ${RENDER_URL}`);

    // Verifica che node-cron sia disponibile
    if (cron) {
        // Cron job ogni 12 minuti - formato: minuto ora giorno mese giornoSettimana
        const cronExpression = '*/12 * * * *'; // Ogni 12 minuti

        console.log(`⏰ Scheduling cron job con pattern: ${cronExpression}`);

        const scheduledTask = cron.schedule(cronExpression, () => {
            const now = new Date();
            console.log(`🏓 Cron job triggered at ${now.toISOString()} - Eseguendo keep-alive ping...`);
            keepServerAlive();
        }, {
            scheduled: true,
            timezone: "Europe/Rome"
        });

        console.log(`✅ Cron job scheduled successfully with pattern: ${cronExpression}`);

        // Primo ping dopo 1 minuto dall'avvio
        setTimeout(() => {
            console.log('🏓 Primo keep-alive ping dopo avvio...');
            keepServerAlive();
        }, 60000);

        // Ping di test ogni 30 secondi per i primi 5 minuti (solo per debug)
        if (process.env.DEBUG_KEEPALIVE === 'true') {
            console.log('🐛 Debug mode: ping ogni 30 secondi per 5 minuti');
            const debugInterval = setInterval(() => {
                console.log('🐛 Debug ping...');
                keepServerAlive();
            }, 30000);

            setTimeout(() => {
                clearInterval(debugInterval);
                console.log('🐛 Debug mode terminato');
            }, 5 * 60 * 1000);
        }

    } else {
        console.error('❌ node-cron non disponibile! Keep-alive non funzionerà correttamente.');

        // Fallback con setInterval
        console.log('🔄 Usando setInterval come fallback...');
        setInterval(() => {
            console.log('🏓 Fallback interval - Eseguendo keep-alive ping...');
            keepServerAlive();
        }, 12 * 60 * 1000); // 12 minuti
    }

} else {
    console.log('💻 Ambiente di sviluppo - Keep-alive disabilitato');
}

// ===== GOOGLE SHEETS & CALENDAR SETUP =====
let sheets;
let calendar;
let googleAuth;

async function initGoogleServices() {
    try {
        let credentials;

        if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
            console.log('📊 Usando credenziali Google da variabile d\'ambiente');
            credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
        } else if (process.env.NODE_ENV === 'development') {
            try {
                console.log('📊 Usando credenziali Google da file locale');
                credentials = require('./google-service-account.json');
            } catch (error) {
                console.warn('⚠️ File google-service-account.json non trovato. Configurare GOOGLE_SERVICE_ACCOUNT_KEY.');
                return;
            }
        } else {
            console.warn('⚠️ Credenziali Google non configurate');
            return;
        }

        googleAuth = new google.auth.GoogleAuth({
            credentials: credentials,
            scopes: [
                'https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/calendar'
            ]
        });

        // Inizializza Google Sheets
        sheets = google.sheets({ version: 'v4', auth: googleAuth });
        console.log('📊 Google Sheets configurato correttamente');

        // Inizializza Google Calendar
        calendar = google.calendar({ version: 'v3', auth: googleAuth });
        console.log('📅 Google Calendar configurato correttamente');

        // Test connessione
        if (process.env.GOOGLE_SPREADSHEET_ID) {
            await testGoogleSheetsConnection();
        }

    } catch (error) {
        console.error('❌ Errore configurazione Google Services:', error.message);
        sheets = null;
        calendar = null;
    }
}

async function testGoogleSheetsConnection() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
            range: 'Prenotazioni!A1:K1'
        });
        console.log('✅ Test Google Sheets OK - Headers trovati:', response.data.values ? response.data.values[0] : 'Nessun header');
    } catch (error) {
        console.warn('⚠️ Test Google Sheets fallito:', error.message);
    }
}

// ===== GOOGLE MEET FUNCTIONS =====
async function createGoogleMeetEvent(bookingData) {
    console.log('📅 createGoogleMeetEvent chiamata con:', {
        calendar: !!calendar,
        calendarId: process.env.GOOGLE_CALENDAR_ID,
        appointmentDate: bookingData.appointmentDate,
        appointmentTime: bookingData.appointmentTime
    });

    if (!calendar) {
        console.warn('⚠️ Google Calendar non configurato - saltando creazione evento');
        return null;
    }

    if (!process.env.GOOGLE_CALENDAR_ID) {
        console.warn('⚠️ GOOGLE_CALENDAR_ID non configurato - saltando creazione evento');
        return null;
    }

    // Calcola i tempi
    const appointmentDate = new Date(bookingData.appointmentDate);
    const [hours, minutes] = bookingData.appointmentTime.split(':');

    const startTime = new Date(appointmentDate);
    startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    const endTime = new Date(startTime);
    endTime.setMinutes(endTime.getMinutes() + 90);

    try {
        console.log('📅 Creazione evento Google Calendar con Meet link fisso:', {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            customerName: bookingData.customerName,
            customerEmail: bookingData.customerEmail
        });

        // Link Google Meet fisso (configurato su Render)
        const fixedMeetLink = process.env.GOOGLE_MEET_LINK || 'https://meet.google.com/tyv-rqts-nyr';

        const event = {
            summary: `VFX Consultation - ${bookingData.customerName}`,
            description: `
VFX Career Consultation with Valentin Procida

Cliente: ${bookingData.customerName}
Email: ${bookingData.customerEmail}
Telefono: ${bookingData.customerPhone}
${bookingData.company ? `Azienda: ${bookingData.company}` : ''}

Durata: 90 minuti
Pagamento: €${(bookingData.amount / 100).toFixed(2)}
ID Transazione: ${bookingData.paymentIntent}

🎥 GOOGLE MEET LINK: ${fixedMeetLink}

Argomenti da discutere:
- Analisi portfolio VFX
- Roadmap carriera personalizzata
- Strategie industria VFX
- CV e networking tips

IMPORTANTE: Il link Google Meet è incluso sopra
            `.trim(),
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            location: fixedMeetLink, // Aggiunge il link anche nel campo location
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 },
                    { method: 'popup', minutes: 10 }
                ]
            }
        };

        console.log('📅 Creazione evento con Meet link fisso:', fixedMeetLink);

        const createdEvent = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            sendUpdates: 'none'
        });

        console.log('✅ Evento creato con Meet link fisso:', {
            eventId: createdEvent.data.id,
            meetLink: fixedMeetLink,
            eventLink: createdEvent.data.htmlLink
        });

        const meetingInfo = {
            eventId: createdEvent.data.id,
            meetLink: fixedMeetLink, // Usa il link fisso
            eventLink: createdEvent.data.htmlLink,
            startTime: startTime,
            endTime: endTime
        };

        console.log('🔗 Usato Google Meet Link fisso:', meetingInfo.meetLink);
        return meetingInfo;

    } catch (error) {
        console.error('❌ Errore creazione evento Google Calendar:', {
            message: error.message,
            code: error.code,
            errors: error.errors
        });
        return null;
    }
}

// ===== FUNZIONI GOOGLE SHEETS =====
async function saveBookingToGoogleSheets(bookingData) {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        console.warn('⚠️ Google Sheets non configurato - saltando salvataggio');
        return;
    }

    try {
        const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

        const date = new Date(bookingData.appointmentDate || new Date());
        const formattedDate = date.toLocaleDateString('it-IT');
        const finalAmount = (bookingData.amount / 100).toFixed(2);
        const discountText = bookingData.discount ?
            `${bookingData.discount.code} (-€${(bookingData.discount.discountAmount / 100).toFixed(2)})` :
            'Nessuno';

        const values = [[
            new Date().toLocaleString('it-IT'),
            bookingData.customerName || bookingData.name,
            bookingData.customerEmail || bookingData.email,
            bookingData.customerPhone || bookingData.phone,
            bookingData.company || '',
            formattedDate,
            bookingData.appointmentTime || 'Non specificato',
            `€${finalAmount}`,
            discountText,
            bookingData.paymentIntent || bookingData.paymentId,
            'Confermata'
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Prenotazioni!A:K',
            valueInputOption: 'USER_ENTERED',
            resource: { values }
        });

        console.log('✅ Prenotazione salvata in Google Sheets:', bookingData.customerEmail || bookingData.email);

    } catch (error) {
        console.error('❌ Errore salvataggio Google Sheets:', error.message);
    }
}

// ===== CLASSE GENERATORE CODICI SCONTO =====
class DiscountCodeGenerator {
    constructor() {
        this.prefixes = {
            general: ['SAVE', 'GET', 'DEAL', 'PROMO', 'OFFER'],
            seasonal: ['SPRING', 'SUMMER', 'AUTUMN', 'WINTER'],
            target: ['STUDENT', 'ARTIST', 'JUNIOR', 'SENIOR', 'FREELANCE'],
            social: ['YOUTUBE', 'INSTAGRAM', 'LINKEDIN', 'TWITTER', 'TIKTOK'],
            events: ['WORKSHOP', 'WEBINAR', 'CONFERENCE', 'MEETUP', 'LIVE'],
            special: ['FLASH', 'WEEKEND', 'MIDNIGHT', 'EARLY', 'LAST'],
            welcome: ['WELCOME', 'HELLO', 'FIRST', 'NEW', 'START']
        };
        this.suffixes = ['10', '2025', 'NOW', 'VFX', 'GO'];
        this.generatedCodes = new Map();
        this.defaultConfig = { type: 'percentage', value: 10, active: true };
    }

    generateRandomCode(length = 8) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    generateThematicCode(category, customSuffix = null) {
        if (!this.prefixes[category]) throw new Error(`Categoria non valida: ${category}`);
        const prefix = this.prefixes[category][Math.floor(Math.random() * this.prefixes[category].length)];
        const suffix = customSuffix || this.suffixes[Math.floor(Math.random() * this.suffixes.length)];
        return `${prefix}${suffix}`;
    }

    isCodeUnique(code) {
        return !this.generatedCodes.has(code) && !discountCodes[code];
    }

    generateUniqueCode(category = null, maxRetries = 10) {
        let attempts = 0;
        let code;
        do {
            code = category ? this.generateThematicCode(category) : this.generateRandomCode();
            attempts++;
        } while (!this.isCodeUnique(code) && attempts < maxRetries);

        if (attempts >= maxRetries) {
            const timestamp = Date.now().toString().slice(-4);
            code = category ? this.generateThematicCode(category, timestamp) : this.generateRandomCode() + timestamp;
        }
        return code;
    }

    createDiscountCode(options = {}) {
        const { category = null, description = null, maxUses = 100, validUntil = null, customCode = null } = options;
        const code = customCode || this.generateUniqueCode(category);

        let autoDescription = description;
        if (!autoDescription) {
            const categoryNames = {
                general: 'Offerta Generale', seasonal: 'Offerta Stagionale', target: 'Offerta Specializzata',
                social: 'Social Media', events: 'Eventi', special: 'Offerta Speciale', welcome: 'Benvenuto'
            };
            autoDescription = category ? `${categoryNames[category]} - Sconto 10%` : 'Codice Automatico - Sconto 10%';
        }

        const discountCode = {
            ...this.defaultConfig, description: autoDescription, maxUses, usedCount: 0,
            validUntil, createdAt: new Date(), category: category || 'generated'
        };

        this.generatedCodes.set(code, discountCode);
        return { code, ...discountCode };
    }

    getAllCodes() {
        const codes = {};
        this.generatedCodes.forEach((data, code) => { codes[code] = data; });
        return codes;
    }

    getStats() {
        const totalCodes = this.generatedCodes.size;
        const activeCodes = Array.from(this.generatedCodes.values()).filter(code => code.active).length;
        const expiredCodes = Array.from(this.generatedCodes.values()).filter(code => code.validUntil && new Date() > code.validUntil).length;
        return {
            totalCodes, activeCodes, expiredCodes,
            totalUses: Array.from(this.generatedCodes.values()).reduce((sum, code) => sum + code.usedCount, 0)
        };
    }
}

// Inizializza il generatore
const codeGenerator = new DiscountCodeGenerator();

// ===== DATABASE CODICI SCONTO =====
let discountCodes = {
    'WELCOME10': {
        type: 'percentage', value: 10, description: 'Benvenuto - Sconto 10%',
        active: true, maxUses: null, usedCount: 0, validUntil: null
    },
    'STUDENT10': {
        type: 'percentage', value: 10, description: 'Studenti - Sconto 10%',
        active: true, maxUses: null, usedCount: 0, validUntil: null
    },
    'FIRST10': {
        type: 'percentage', value: 10, description: 'Prima Consulenza - Sconto 10%',
        active: true, maxUses: 500, usedCount: 0, validUntil: null
    }
};

// ===== CONFIGURAZIONE EMAIL =====
const emailConfig = {
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
};

let transporter;
if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
    transporter = nodemailer.createTransport(emailConfig); // ✅ FIXED: createTransport instead of createTransporter
    console.log('📧 Email transporter configurato');
}

// ===== TEMPLATE EMAIL MIGLIORATI =====
function createBookingConfirmationTemplate(bookingData) {
    const date = new Date(bookingData.appointmentDate || new Date());
    const formattedDate = date.toLocaleDateString('it-IT', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const finalAmount = (bookingData.amount / 100).toFixed(2);

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Prenotazione Confermata</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F8F6F3; color: #2D2D2D; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; background: #FEFCF9; box-shadow: 0 25px 50px -12px rgba(45, 45, 45, 0.25);">
        
        <!-- Header Elegante -->
        <div style="background: linear-gradient(135deg, #1A1A1A 0%, #2D2D2D 100%); padding: 3rem 2rem; text-align: center; position: relative; overflow: hidden;">
            <div style="position: absolute; top: -50px; right: -50px; width: 100px; height: 100px; background: rgba(184, 160, 130, 0.1); border-radius: 50%;"></div>
            <div style="position: absolute; bottom: -30px; left: -30px; width: 80px; height: 80px; background: rgba(184, 160, 130, 0.1); border-radius: 50%;"></div>
            <div style="position: relative; z-index: 2;">
                <div style="width: 60px; height: 60px; background: #5A6B4D; border-radius: 50%; margin: 0 auto 1.5rem; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">✓</div>
                <h1 style="margin: 0; font-size: 1.75rem; font-weight: 300; color: #FEFCF9; letter-spacing: -0.02em;">Prenotazione Confermata</h1>
                <p style="margin: 0.75rem 0 0 0; color: rgba(254, 252, 249, 0.8); font-size: 0.875rem; text-transform: uppercase; letter-spacing: 1px; font-weight: 500;">Consulenza VFX • Valentin Procida</p>
            </div>
        </div>
        
        <!-- Content -->
        <div style="padding: 3rem 2rem;">
            
            <div style="text-align: center; margin-bottom: 3rem;">
                <h2 style="color: #2D2D2D; margin: 0 0 1rem 0; font-size: 1.5rem; font-weight: 300; letter-spacing: -0.02em;">Ciao ${bookingData.customerName || bookingData.name}!</h2>
                <p style="color: #6B6B6B; font-size: 1rem; line-height: 1.7; margin: 0; max-width: 400px; margin: 0 auto;">
                    La tua consulenza VFX è stata confermata con successo. 
                    <strong style="color: #2D2D2D;">Riceverai il link Google Meet in una email separata tra pochi minuti.</strong>
                </p>
            </div>
            
            <!-- Appointment Card -->
            <div style="background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 0; padding: 2rem; margin-bottom: 2rem; position: relative;">
                <div style="position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: #B8A082;"></div>
                <div style="margin-left: 1rem;">
                    <h3 style="color: #2D2D2D; margin: 0 0 1.5rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">Dettagli Appuntamento</h3>
                    <div style="display: grid; gap: 1rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #E8E6E3;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Data</span>
                            <span style="color: #2D2D2D; font-weight: 500;">${formattedDate}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #E8E6E3;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Orario</span>
                            <span style="color: #2D2D2D; font-weight: 500;">${bookingData.appointmentTime || 'Da confermare'}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #E8E6E3;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Durata</span>
                            <span style="color: #2D2D2D; font-weight: 500;">90 minuti</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Modalità</span>
                            <span style="color: #2D2D2D; font-weight: 500;">Google Meet</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Payment Summary -->
            <div style="background: rgba(122, 132, 113, 0.1); border: 1px solid #7A8471; border-radius: 0; padding: 2rem; margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1.5rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">Riepilogo Pagamento</h3>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
                    <span style="color: #6B6B6B; font-size: 0.875rem;">Consulenza VFX</span>
                    <span style="color: #2D2D2D; font-weight: 600; font-size: 1.125rem;">€${finalAmount}</span>
                </div>
                ${bookingData.discount ? `
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 0.75rem; background: rgba(122, 132, 113, 0.1); border-radius: 4px;">
                    <span style="color: #7A8471; font-size: 0.875rem; font-weight: 500;">Sconto ${bookingData.discount.code}</span>
                    <span style="color: #7A8471; font-weight: 600;">Applicato ✓</span>
                </div>` : ''}
                <div style="border-top: 1px solid #7A8471; padding-top: 1rem; margin-top: 1rem;">
                    <span style="color: #6B6B6B; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px;">ID Transazione: ${bookingData.paymentIntent || bookingData.paymentId}</span>
                </div>
            </div>
            
            <!-- Google Meet Notice -->
            <div style="background: linear-gradient(135deg, #1A1A1A 0%, #2D2D2D 100%); color: #FEFCF9; padding: 2rem; border-radius: 0; text-align: center; margin-bottom: 2rem;">
                <div style="width: 50px; height: 50px; background: rgba(184, 160, 130, 0.2); border-radius: 50%; margin: 0 auto 1rem; display: flex; align-items: center; justify-content: center; font-size: 1.25rem;">🎥</div>
                <h3 style="color: #FEFCF9; margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: 500;">Link Google Meet in Arrivo</h3>
                <p style="margin: 0; opacity: 0.9; line-height: 1.6;">
                    Ti invieremo il link per la video chiamata in una <strong>email separata tra pochi minuti</strong>.<br>
                    Controlla la tua casella di posta!
                </p>
            </div>
            
            <!-- Preparation Section -->
            <div style="margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1.5rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; position: relative;">
                    Preparazione Consigliata
                    <div style="position: absolute; bottom: -0.5rem; left: 0; width: 60px; height: 1px; background: #B8A082;"></div>
                </h3>
                <div style="display: grid; gap: 1rem; margin-top: 2rem;">
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 24px; height: 24px; background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">📁</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Prepara il tuo portfolio/reel più recente</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 24px; height: 24px; background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">❓</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Elenca le tue domande specifiche</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 24px; height: 24px; background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">🎯</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Pensa ai tuoi obiettivi di carriera</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 24px; height: 24px; background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">📝</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Avere carta e penna per prendere note</span>
                    </div>
                </div>
            </div>
            
            <!-- Support -->
            <div style="text-align: center; padding: 2rem; background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 0;">
                <p style="margin: 0; color: #6B6B6B; font-size: 0.875rem; line-height: 1.6;">
                    Hai domande? Rispondi pure a questa email.<br>
                    <strong style="color: #2D2D2D;">Ci sentiamo presto!</strong>
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #1A1A1A; color: #FEFCF9; padding: 2rem; text-align: center;">
            <div style="margin-bottom: 1rem;">
                <strong style="font-size: 1.125rem; font-weight: 500;">Valentin Procida</strong>
            </div>
            <div style="color: rgba(254, 252, 249, 0.8); font-size: 0.875rem; line-height: 1.6;">
                VFX Artist & Career Consultant<br>
                <a href="https://www.valentinprocida.it" style="color: #B8A082; text-decoration: none; font-weight: 500;">www.valentinprocida.it</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function createMeetingLinkEmailTemplate(bookingData, meetingInfo) {
    const date = new Date(bookingData.appointmentDate);
    const formattedDate = date.toLocaleDateString('it-IT', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const startTime = meetingInfo.startTime.toLocaleTimeString('it-IT', {
        hour: '2-digit',
        minute: '2-digit'
    });

    const endTime = meetingInfo.endTime.toLocaleTimeString('it-IT', {
        hour: '2-digit',
        minute: '2-digit'
    });

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Link Google Meet - Valentin Procida</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F8F6F3; color: #2D2D2D; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; background: #FEFCF9; box-shadow: 0 25px 50px -12px rgba(45, 45, 45, 0.25);">
        
        <!-- Header Elegante -->
        <div style="background: linear-gradient(135deg, #5A6B4D 0%, #7A8471 100%); padding: 3rem 2rem; text-align: center; position: relative; overflow: hidden;">
            <div style="position: absolute; top: -40px; right: -40px; width: 80px; height: 80px; background: rgba(254, 252, 249, 0.1); border-radius: 50%;"></div>
            <div style="position: absolute; bottom: -20px; left: -20px; width: 60px; height: 60px; background: rgba(254, 252, 249, 0.1); border-radius: 50%;"></div>
            <div style="position: relative; z-index: 2;">
                <div style="width: 60px; height: 60px; background: rgba(254, 252, 249, 0.2); border: 2px solid rgba(254, 252, 249, 0.3); border-radius: 50%; margin: 0 auto 1.5rem; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">🎥</div>
                <h1 style="margin: 0; font-size: 1.75rem; font-weight: 300; color: #FEFCF9; letter-spacing: -0.02em;">Google Meet Pronto!</h1>
                <p style="margin: 0.75rem 0 0 0; color: rgba(254, 252, 249, 0.8); font-size: 0.875rem; text-transform: uppercase; letter-spacing: 1px; font-weight: 500;">Il tuo link è qui sotto</p>
            </div>
        </div>
        
        <!-- Content -->
        <div style="padding: 3rem 2rem;">
            
            <div style="text-align: center; margin-bottom: 3rem;">
                <h2 style="color: #2D2D2D; margin: 0 0 1rem 0; font-size: 1.5rem; font-weight: 300; letter-spacing: -0.02em;">Ciao ${bookingData.customerName}!</h2>
                <p style="color: #6B6B6B; font-size: 1rem; line-height: 1.7; margin: 0; max-width: 400px; margin: 0 auto;">
                    La tua prenotazione è completa! Usa il link qui sotto per unirti alla video chiamata. 
                    <strong style="color: #2D2D2D;">Salva questa email.</strong>
                </p>
            </div>
            
            <!-- Google Meet Link prominente -->
            <div style="background: linear-gradient(135deg, #1A1A1A 0%, #2D2D2D 100%); border-radius: 0; padding: 3rem 2rem; text-align: center; margin-bottom: 3rem; position: relative; overflow: hidden;">
                <div style="position: absolute; top: -30px; right: -30px; width: 60px; height: 60px; background: rgba(184, 160, 130, 0.1); border-radius: 50%;"></div>
                <div style="position: relative; z-index: 2;">
                    <h3 style="margin: 0 0 2rem 0; color: #FEFCF9; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">Link Video Chiamata</h3>
                    <a href="${meetingInfo.meetLink}" 
                       style="background: #FEFCF9; color: #1A1A1A; padding: 1.25rem 2.5rem; text-decoration: none; 
                              border-radius: 0; font-weight: 600; font-size: 1rem; display: inline-block; 
                              text-transform: uppercase; letter-spacing: 1px; border: 2px solid transparent; 
                              transition: all 0.3s ease;">
                        🎥 Unisciti alla Chiamata
                    </a>
                    <p style="margin: 2rem 0 0 0; color: rgba(254, 252, 249, 0.8); font-size: 0.875rem;">
                        Clicca 5-10 minuti prima dell'appuntamento
                    </p>
                </div>
            </div>
            
            <!-- Meeting Schedule -->
            <div style="background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 0; padding: 2rem; margin-bottom: 2rem; position: relative;">
                <div style="position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: #5A6B4D;"></div>
                <div style="margin-left: 1rem;">
                    <h3 style="color: #2D2D2D; margin: 0 0 1.5rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">Programma</h3>
                    <div style="display: grid; gap: 1rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #E8E6E3;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Data</span>
                            <span style="color: #2D2D2D; font-weight: 500;">${formattedDate}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #E8E6E3;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Orario</span>
                            <span style="color: #2D2D2D; font-weight: 500;">${startTime} - ${endTime}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0; border-bottom: 1px solid #E8E6E3;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Fuso Orario</span>
                            <span style="color: #2D2D2D; font-weight: 500;">Europe/Rome (GMT+1)</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.75rem 0;">
                            <span style="color: #6B6B6B; font-size: 0.875rem; font-weight: 500;">Durata</span>
                            <span style="color: #2D2D2D; font-weight: 500;">90 minuti</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Calendar Integration -->
            <div style="text-align: center; margin-bottom: 2rem;">
                <a href="${meetingInfo.eventLink}" 
                   style="background: transparent; color: #2D2D2D; padding: 1rem 2rem; text-decoration: none; 
                          border: 2px solid #E8E6E3; border-radius: 0; font-weight: 500; display: inline-block; 
                          text-transform: uppercase; letter-spacing: 1px; font-size: 0.875rem;">
                    📅 Apri nel Google Calendar
                </a>
                <p style="color: #9B9B9B; margin: 1rem 0 0 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px;">
                    Evento automaticamente aggiunto
                </p>
            </div>
            
            <!-- Checklist -->
            <div style="margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1.5rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; position: relative;">
                    Checklist Pre-Chiamata
                    <div style="position: absolute; bottom: -0.5rem; left: 0; width: 60px; height: 1px; background: #B8A082;"></div>
                </h3>
                <div style="display: grid; gap: 1rem; margin-top: 2rem;">
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 20px; height: 20px; background: transparent; border: 2px solid #E8E6E3; border-radius: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">✓</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Salva questa email con il link</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 20px; height: 20px; background: transparent; border: 2px solid #E8E6E3; border-radius: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">✓</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Testa audio e video</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 20px; height: 20px; background: transparent; border: 2px solid #E8E6E3; border-radius: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">✓</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Ambiente silenzioso</span>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 1rem;">
                        <div style="width: 20px; height: 20px; background: transparent; border: 2px solid #E8E6E3; border-radius: 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 0.125rem;">
                            <span style="font-size: 0.75rem; color: #6B6B6B;">✓</span>
                        </div>
                        <span style="color: #6B6B6B; line-height: 1.6;">Portfolio pronto</span>
                    </div>
                </div>
            </div>
            
            <!-- Support -->
            <div style="text-align: center; padding: 2rem; background: rgba(197, 83, 74, 0.05); border: 1px solid rgba(197, 83, 74, 0.2); border-radius: 0;">
                <p style="margin: 0; color: #6B6B6B; font-size: 0.875rem; line-height: 1.6;">
                    <strong style="color: #2D2D2D;">Problemi tecnici?</strong><br>
                    Contattami subito: 
                    <a href="mailto:${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}" style="color: #C5534A; text-decoration: none; font-weight: 500;">
                        ${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}
                    </a>
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #1A1A1A; color: #FEFCF9; padding: 2rem; text-align: center;">
            <div style="margin-bottom: 1rem;">
                <strong style="font-size: 1.125rem; font-weight: 500;">Valentin Procida</strong>
            </div>
            <div style="color: rgba(254, 252, 249, 0.8); font-size: 0.875rem; line-height: 1.6;">
                VFX Artist & Career Consultant<br>
                <a href="https://www.valentinprocida.it" style="color: #B8A082; text-decoration: none; font-weight: 500;">www.valentinprocida.it</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function createDiscountEmailTemplate(name, discountCode, discountAmount) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Discount Code - Valentin Procida</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F8F6F3; color: #2D2D2D; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; background: #FEFCF9; box-shadow: 0 25px 50px -12px rgba(45, 45, 45, 0.25);">
        
        <!-- Header Elegante -->
        <div style="background: linear-gradient(135deg, #B8A082 0%, #D4D2CF 100%); padding: 3rem 2rem; text-align: center; position: relative; overflow: hidden;">
            <div style="position: absolute; top: -50px; right: -50px; width: 100px; height: 100px; background: rgba(26, 26, 26, 0.1); border-radius: 50%;"></div>
            <div style="position: absolute; bottom: -30px; left: -30px; width: 80px; height: 80px; background: rgba(26, 26, 26, 0.1); border-radius: 50%;"></div>
            <div style="position: relative; z-index: 2;">
                <div style="width: 60px; height: 60px; background: rgba(26, 26, 26, 0.1); border: 2px solid rgba(26, 26, 26, 0.2); border-radius: 50%; margin: 0 auto 1.5rem; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">🎉</div>
                <h1 style="margin: 0; font-size: 1.75rem; font-weight: 300; color: #1A1A1A; letter-spacing: -0.02em;">Your Discount is Ready!</h1>
                <p style="margin: 0.75rem 0 0 0; color: rgba(26, 26, 26, 0.7); font-size: 0.875rem; text-transform: uppercase; letter-spacing: 1px; font-weight: 500;">Exclusive ${discountAmount}% VFX Consultation Discount</p>
            </div>
        </div>
        
        <!-- Content -->
        <div style="padding: 3rem 2rem;">
            
            <div style="text-align: center; margin-bottom: 3rem;">
                <h2 style="color: #2D2D2D; margin: 0 0 1rem 0; font-size: 1.5rem; font-weight: 300; letter-spacing: -0.02em;">${name ? `Hi ${name}!` : 'Hello!'}</h2>
                <p style="color: #6B6B6B; font-size: 1rem; line-height: 1.7; margin: 0; max-width: 400px; margin: 0 auto;">
                    Thank you for your interest in my VFX consultation services! 
                    <strong style="color: #2D2D2D;">Here's your exclusive discount code:</strong>
                </p>
            </div>
            
            <!-- Discount Code prominente -->
            <div style="background: linear-gradient(135deg, #1A1A1A 0%, #2D2D2D 100%); border-radius: 0; padding: 3rem 2rem; text-align: center; margin-bottom: 3rem; position: relative; overflow: hidden;">
                <div style="position: absolute; top: -40px; right: -40px; width: 80px; height: 80px; background: rgba(184, 160, 130, 0.1); border-radius: 50%;"></div>
                <div style="position: relative; z-index: 2;">
                    <p style="color: rgba(254, 252, 249, 0.8); margin: 0 0 1rem 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Your Discount Code</p>
                    <div style="background: #FEFCF9; color: #1A1A1A; padding: 1.5rem 2rem; border-radius: 0; margin: 1.5rem 0; font-size: 2rem; font-weight: 700; letter-spacing: 4px; font-family: 'Courier New', monospace; border: 2px solid #E8E6E3;">${discountCode}</div>
                    <p style="color: #FEFCF9; margin: 1rem 0 0 0; font-size: 1.125rem; font-weight: 500;">Save ${discountAmount}% on your VFX consultation</p>
                </div>
            </div>
            
            <!-- CTA Button -->
            <div style="text-align: center; margin-bottom: 3rem;">
                <a href="https://www.valentinprocida.it/buy.html" 
                   style="background: #5A6B4D; color: #FEFCF9; padding: 1.25rem 2.5rem; text-decoration: none; 
                          border-radius: 0; font-weight: 600; font-size: 1rem; display: inline-block;
                          text-transform: uppercase; letter-spacing: 1px; border: 2px solid transparent;">
                    🚀 Book Your Consultation Now
                </a>
                <p style="color: #9B9B9B; margin: 1rem 0 0 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px;">
                    Limited time offer
                </p>
            </div>
            
            <!-- Instructions -->
            <div style="background: #F8F6F3; border: 1px solid #E8E6E3; border-radius: 0; padding: 2rem; margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1.5rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; text-align: center;">How to Use Your Code</h3>
                <div style="display: grid; gap: 1.5rem; margin-top: 2rem;">
                    <div style="display: flex; align-items: center; gap: 1.5rem;">
                        <div style="width: 32px; height: 32px; background: #5A6B4D; color: #FEFCF9; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem;">1</div>
                        <span style="color: #2D2D2D; line-height: 1.6; font-weight: 500;">Visit the consultation booking page</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1.5rem;">
                        <div style="width: 32px; height: 32px; background: #5A6B4D; color: #FEFCF9; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem;">2</div>
                        <span style="color: #2D2D2D; line-height: 1.6;">Enter code <strong style="font-family: 'Courier New', monospace; background: #E8E6E3; padding: 0.25rem 0.5rem; border-radius: 2px;">${discountCode}</strong> at checkout</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 1.5rem;">
                        <div style="width: 32px; height: 32px; background: #5A6B4D; color: #FEFCF9; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; flex-shrink: 0; font-size: 0.875rem;">3</div>
                        <span style="color: #2D2D2D; line-height: 1.6; font-weight: 500;">Enjoy your ${discountAmount}% discount!</span>
                    </div>
                </div>
            </div>
            
            <!-- Expiration Notice -->
            <div style="text-align: center; padding: 2rem; background: rgba(197, 83, 74, 0.05); border: 1px solid rgba(197, 83, 74, 0.2); border-radius: 0;">
                <p style="color: #6B6B6B; margin: 0; font-size: 0.875rem; line-height: 1.6;">
                    ⏰ <strong style="color: #C5534A;">This code expires in 30 days.</strong><br>
                    Questions? Reply to this email and I'll help you out!
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #1A1A1A; color: #FEFCF9; padding: 2rem; text-align: center;">
            <div style="margin-bottom: 1rem;">
                <h3 style="margin: 0 0 0.5rem 0; font-size: 1.125rem; font-weight: 500;">Best regards,</h3>
                <strong style="font-size: 1.25rem; font-weight: 600;">Valentin Procida</strong>
            </div>
            <div style="color: rgba(254, 252, 249, 0.8); font-size: 0.875rem; line-height: 1.6; margin-bottom: 1.5rem;">
                VFX Artist & Rigger
            </div>
            <div style="display: flex; justify-content: center; gap: 2rem; flex-wrap: wrap;">
                <a href="https://www.linkedin.com/in/valentinprocida" style="color: #B8A082; text-decoration: none; font-size: 0.875rem; font-weight: 500;">LinkedIn</a>
                <a href="https://vimeo.com/valentinprocida" style="color: #B8A082; text-decoration: none; font-size: 0.875rem; font-weight: 500;">Vimeo</a>
                <a href="https://www.valentinprocida.it" style="color: #B8A082; text-decoration: none; font-size: 0.875rem; font-weight: 500;">Website</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

function createAdminNotificationTemplate(bookingData) {
    const date = new Date(bookingData.appointmentDate || new Date());
    const formattedDate = date.toLocaleDateString('it-IT', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    const finalAmount = (bookingData.amount / 100).toFixed(2);

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Booking - Admin Notification</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
</head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #F8F6F3; color: #2D2D2D; line-height: 1.6;">
    <div style="max-width: 600px; margin: 0 auto; background: #FEFCF9; box-shadow: 0 25px 50px -12px rgba(45, 45, 45, 0.25);">
        
        <!-- Header Admin -->
        <div style="background: linear-gradient(135deg, #7A8471 0%, #5A6B4D 100%); padding: 2rem; text-align: center; position: relative; overflow: hidden;">
            <div style="position: absolute; top: -30px; right: -30px; width: 60px; height: 60px; background: rgba(254, 252, 249, 0.1); border-radius: 50%;"></div>
            <div style="position: relative; z-index: 2;">
                <div style="width: 50px; height: 50px; background: rgba(254, 252, 249, 0.2); border-radius: 50%; margin: 0 auto 1rem; display: flex; align-items: center; justify-content: center; font-size: 1.25rem;">🎯</div>
                <h1 style="margin: 0; font-size: 1.5rem; font-weight: 600; color: #FEFCF9;">Nuova Prenotazione</h1>
                <p style="margin: 0.5rem 0 0 0; color: rgba(254, 252, 249, 0.8); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px;">Sistema VFX Booking</p>
            </div>
        </div>
        
        <!-- Content Admin -->
        <div style="padding: 2rem;">
            
            <!-- Customer Section -->
            <div style="margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; position: relative;">
                    👤 Cliente
                    <div style="position: absolute; bottom: -0.25rem; left: 0; width: 40px; height: 1px; background: #7A8471;"></div>
                </h3>
                <div style="background: #F8F6F3; border-left: 4px solid #7A8471; padding: 1.5rem; margin-top: 1rem;">
                    <div style="display: grid; gap: 0.75rem;">
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Nome:</span>
                            <span style="color: #2D2D2D; font-weight: 600;">${bookingData.customerName || bookingData.name}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Email:</span>
                            <a href="mailto:${bookingData.customerEmail || bookingData.email}" style="color: #7A8471; text-decoration: none; font-weight: 500;">${bookingData.customerEmail || bookingData.email}</a>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Telefono:</span>
                            <a href="tel:${bookingData.customerPhone || bookingData.phone}" style="color: #7A8471; text-decoration: none; font-weight: 500;">${bookingData.customerPhone || bookingData.phone}</a>
                        </div>
                        ${bookingData.company ? `
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Azienda:</span>
                            <span style="color: #2D2D2D; font-weight: 600;">${bookingData.company}</span>
                        </div>` : ''}
                    </div>
                </div>
            </div>
            
            <!-- Appointment Section -->
            <div style="margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; position: relative;">
                    📅 Appuntamento
                    <div style="position: absolute; bottom: -0.25rem; left: 0; width: 40px; height: 1px; background: #B8A082;"></div>
                </h3>
                <div style="background: rgba(184, 160, 130, 0.1); border-left: 4px solid #B8A082; padding: 1.5rem; margin-top: 1rem;">
                    <div style="display: grid; gap: 0.75rem;">
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Data:</span>
                            <span style="color: #2D2D2D; font-weight: 600;">${formattedDate}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Orario:</span>
                            <span style="color: #2D2D2D; font-weight: 600;">${bookingData.appointmentTime || 'Non specificato'}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Durata:</span>
                            <span style="color: #2D2D2D; font-weight: 600;">90 minuti</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Payment Section -->
            <div style="margin-bottom: 2rem;">
                <h3 style="color: #2D2D2D; margin: 0 0 1rem 0; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; position: relative;">
                    💰 Pagamento
                    <div style="position: absolute; bottom: -0.25rem; left: 0; width: 40px; height: 1px; background: #7A8471;"></div>
                </h3>
                <div style="background: rgba(122, 132, 113, 0.1); border-left: 4px solid #7A8471; padding: 1.5rem; margin-top: 1rem;">
                    <div style="display: grid; gap: 0.75rem;">
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Importo:</span>
                            <span style="color: #2D2D2D; font-weight: 700; font-size: 1.125rem;">€${finalAmount}</span>
                        </div>
                        ${bookingData.discount ? `
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #6B6B6B; font-weight: 500;">Sconto:</span>
                            <span style="color: #7A8471; font-weight: 600;">${bookingData.discount.code} (-€${(bookingData.discount.discountAmount / 100).toFixed(2)})</span>
                        </div>` : ''}
                        <div style="display: flex; justify-content: space-between; font-size: 0.875rem;">
                            <span style="color: #6B6B6B; font-weight: 500;">ID Stripe:</span>
                            <code style="background: #E8E6E3; padding: 0.25rem 0.5rem; border-radius: 2px; font-size: 0.75rem; color: #2D2D2D;">${bookingData.paymentIntent || bookingData.paymentId}</code>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-size: 0.875rem;">
                            <span style="color: #6B6B6B; font-weight: 500;">Timestamp:</span>
                            <span style="color: #2D2D2D; font-weight: 500;">${new Date().toLocaleString('it-IT')}</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Quick Actions -->
            <div style="text-align: center; gap: 1rem; display: flex; flex-wrap: wrap; justify-content: center;">
                ${process.env.GOOGLE_SPREADSHEET_ID ? `
                <a href="https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}" 
                   style="background: #7A8471; color: #FEFCF9; padding: 0.75rem 1.5rem; text-decoration: none; 
                          border-radius: 0; font-weight: 600; display: inline-block; font-size: 0.875rem;
                          text-transform: uppercase; letter-spacing: 1px;">
                    📊 Google Sheets
                </a>` : ''}
                <a href="mailto:${bookingData.customerEmail || bookingData.email}" 
                   style="background: #1A1A1A; color: #FEFCF9; padding: 0.75rem 1.5rem; text-decoration: none; 
                          border-radius: 0; font-weight: 600; display: inline-block; font-size: 0.875rem;
                          text-transform: uppercase; letter-spacing: 1px;">
                    📧 Email Cliente
                </a>
            </div>
            
        </div>
        
        <!-- Footer Admin -->
        <div style="background: #1A1A1A; color: #FEFCF9; padding: 1.5rem; text-align: center;">
            <p style="margin: 0; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: rgba(254, 252, 249, 0.6);">
                Sistema VFX Booking • Powered by Valentin Procida
            </p>
        </div>
    </div>
</body>
</html>`;
}

// ===== SCHEDULER & EMAIL FUNCTIONS =====
function scheduleReminderEmail(bookingData, meetingInfo, sendImmediately = true) {
    console.log('📧 scheduleReminderEmail chiamata con:', {
        appointmentDate: bookingData.appointmentDate,
        appointmentTime: bookingData.appointmentTime,
        meetingInfo: meetingInfo ? 'PRESENTE' : 'MANCANTE',
        sendImmediately: sendImmediately
    });

    if (!meetingInfo) {
        console.error('❌ meetingInfo è null - non posso programmare email Google Meet');
        return;
    }

    // ✅ FIX: Se sendImmediately è true, invia subito
    if (sendImmediately) {
        console.log('📧 Invio IMMEDIATO dell\'email Google Meet (come richiesto)');
        sendMeetingLinkEmail(bookingData, meetingInfo);
        return;
    }

    // Logica originale per invio programmato (solo se sendImmediately = false)
    const appointmentDate = new Date(bookingData.appointmentDate);
    const [hours, minutes] = bookingData.appointmentTime.split(':');

    const meetingTime = new Date(appointmentDate);
    meetingTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

    const reminderTime = new Date(meetingTime.getTime() - 24 * 60 * 60 * 1000);
    const now = new Date();

    console.log('⏰ Tempi calcolati:', {
        appointmentTime: meetingTime.toLocaleString('it-IT'),
        reminderTime: reminderTime.toLocaleString('it-IT'),
        now: now.toLocaleString('it-IT'),
        isInPast: reminderTime <= now
    });

    if (reminderTime <= now) {
        console.log('📧 Reminder time nel passato, invio IMMEDIATO dell\'email Google Meet');
        sendMeetingLinkEmail(bookingData, meetingInfo);
        return;
    }

    const timeUntilReminder = reminderTime.getTime() - now.getTime();
    const hoursUntil = timeUntilReminder / (1000 * 60 * 60);

    console.log(`⏰ Email Google Meet programmata per: ${reminderTime.toLocaleString('it-IT')} (tra ${hoursUntil.toFixed(1)} ore)`);

    setTimeout(() => {
        console.log('🚀 Timer scaduto - invio email Google Meet ora');
        sendMeetingLinkEmail(bookingData, meetingInfo);
    }, timeUntilReminder);
}

async function sendMeetingLinkEmail(bookingData, meetingInfo) {
    console.log('📧 sendMeetingLinkEmail chiamata per:', bookingData.customerEmail);

    if (!transporter) {
        console.error('❌ Transporter email non disponibile');
        return;
    }

    try {
        const mailOptions = {
            from: {
                name: 'Valentin Procida',
                address: process.env.EMAIL_USER
            },
            to: bookingData.customerEmail,
            subject: `🎥 Link Google Meet per la tua consulenza VFX - ${new Date(bookingData.appointmentDate).toLocaleDateString('it-IT')}`,
            html: createMeetingLinkEmailTemplate(bookingData, meetingInfo)
        };

        console.log('📧 Invio email Google Meet a:', bookingData.customerEmail);
        await transporter.sendMail(mailOptions);
        console.log(`✅ Email Google Meet inviata con successo a ${bookingData.customerEmail}`);

    } catch (error) {
        console.error('❌ Errore invio email Google Meet:', error);
    }
}

function extractNameFromEmail(email) {
    const localPart = email.split('@')[0];
    const cleanName = localPart.replace(/[0-9._-]/g, ' ').trim();
    return cleanName || null;
}

// ===== FUNZIONI HELPER =====
function generateInitialCodes() {
    console.log('🎫 Generazione automatica codici sconto...');

    for (let i = 0; i < 5; i++) {
        const code = codeGenerator.createDiscountCode({
            category: 'general',
            maxUses: 100,
            validUntil: new Date('2025-12-31')
        });
        discountCodes[code.code] = {
            type: code.type, value: code.value, description: code.description,
            active: code.active, maxUses: code.maxUses, usedCount: code.usedCount,
            validUntil: code.validUntil
        };
    }

    for (let i = 0; i < 3; i++) {
        const code = codeGenerator.createDiscountCode({
            category: 'social',
            maxUses: 200,
            validUntil: new Date('2025-12-31')
        });
        discountCodes[code.code] = {
            type: code.type, value: code.value, description: code.description,
            active: code.active, maxUses: code.maxUses, usedCount: code.usedCount,
            validUntil: code.validUntil
        };
    }

    for (let i = 0; i < 4; i++) {
        const code = codeGenerator.createDiscountCode({
            category: 'special',
            maxUses: 50,
            validUntil: new Date('2025-08-31')
        });
        discountCodes[code.code] = {
            type: code.type, value: code.value, description: code.description,
            active: code.active, maxUses: code.maxUses, usedCount: code.usedCount,
            validUntil: code.validUntil
        };
    }

    console.log(`✅ Generati ${Object.keys(discountCodes).length} codici sconto totali`);
}

function calculateDiscountedPrice(originalPrice, discountCode) {
    const discount = discountCodes[discountCode.toUpperCase()];

    if (!discount || !discount.active) {
        return { valid: false, error: 'Codice sconto non valido' };
    }

    if (discount.validUntil && new Date() > discount.validUntil) {
        return { valid: false, error: 'Codice sconto scaduto' };
    }

    if (discount.maxUses && discount.usedCount >= discount.maxUses) {
        return { valid: false, error: 'Codice sconto esaurito' };
    }

    let discountAmount = 0;
    let finalPrice = originalPrice;

    if (discount.type === 'percentage') {
        discountAmount = Math.round(originalPrice * discount.value / 100);
        finalPrice = originalPrice - discountAmount;
    } else if (discount.type === 'fixed') {
        discountAmount = Math.min(discount.value, originalPrice);
        finalPrice = originalPrice - discountAmount;
    }

    finalPrice = Math.max(finalPrice, 0);

    return {
        valid: true, originalPrice, discountAmount, finalPrice,
        discountCode: discountCode.toUpperCase(), discountDescription: discount.description,
        discountType: discount.type, discountValue: discount.value
    };
}

// ===== MIDDLEWARE =====
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({
    origin: [
        process.env.FRONTEND_URL || 'http://localhost:8000',
        'https://www.valentinprocida.it',
        'http://localhost:3000',
        'http://127.0.0.1:8000'
    ],
    credentials: true
}));

// ===== ENDPOINTS BASE =====
app.get('/api/health', (req, res) => {
    res.json({
        status: 'Server is running!',
        timestamp: new Date(),
        totalDiscountCodes: Object.keys(discountCodes).length,
        emailConfigured: !!transporter,
        googleSheetsConfigured: !!sheets,
        googleCalendarConfigured: !!calendar,
        env: process.env.NODE_ENV || 'development',
        keepAliveActive: process.env.NODE_ENV === 'production',
        renderUrl: process.env.RENDER_URL,
        uptime: `${Math.floor(process.uptime())} seconds`,
        nextCronExecution: process.env.NODE_ENV === 'production' ? 'Check logs for cron schedule' : 'N/A',
        memory: process.memoryUsage()
    });
});

// ✅ NUOVO: Endpoint per testare manualmente il keep-alive
app.get('/api/test-keepalive', async (req, res) => {
    try {
        console.log('🧪 Test keep-alive richiesto manualmente');

        if (process.env.NODE_ENV !== 'production') {
            return res.json({
                success: false,
                message: 'Keep-alive è attivo solo in produzione',
                environment: process.env.NODE_ENV || 'development'
            });
        }

        if (!RENDER_URL || RENDER_URL.includes('localhost')) {
            return res.json({
                success: false,
                message: 'RENDER_URL non configurato',
                renderUrl: RENDER_URL
            });
        }

        // Esegui il ping manualmente
        await keepServerAlive();

        res.json({
            success: true,
            message: 'Keep-alive ping eseguito con successo',
            timestamp: new Date().toISOString(),
            renderUrl: RENDER_URL,
            uptime: process.uptime()
        });

    } catch (error) {
        console.error('❌ Errore test keep-alive:', error);
        res.status(500).json({
            success: false,
            message: 'Errore durante il test keep-alive',
            error: error.message
        });
    }
});

app.get('/api/config', (req, res) => {
    if (!process.env.STRIPE_PUBLISHABLE_KEY) {
        return res.status(500).json({ error: 'Stripe publishable key not configured' });
    }
    res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ===== ENDPOINTS EMAIL E CODICI SCONTO =====
app.post('/api/send-discount-email', async (req, res) => {
    try {
        const { email, name } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email richiesta' });
        }

        if (!transporter) {
            return res.status(500).json({ error: 'Servizio email non configurato' });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Email non valida' });
        }

        const newCode = codeGenerator.createDiscountCode({
            category: 'welcome',
            description: 'Email Signup Discount - Sconto 10%',
            maxUses: 1,
            validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });

        discountCodes[newCode.code] = {
            type: newCode.type,
            value: newCode.value,
            description: newCode.description,
            active: newCode.active,
            maxUses: newCode.maxUses,
            usedCount: newCode.usedCount,
            validUntil: newCode.validUntil,
            assignedTo: email,
            createdAt: new Date()
        };

        const recipientName = name || extractNameFromEmail(email);

        const mailOptions = {
            from: {
                name: 'Valentin Procida',
                address: process.env.EMAIL_USER
            },
            to: email,
            subject: '🎉 Your 10% Discount Code - VFX Consultation',
            html: createDiscountEmailTemplate(recipientName, newCode.code, 10),
            text: `
Hi ${recipientName || 'there'}!

Thank you for your interest in my VFX consultation services!

Your discount code: ${newCode.code}
This code gives you 10% off your consultation.

Book now: https://www.valentinprocida.it/buy.html

Best regards,
Valentin Procida
VFX Artist & Rigger
            `
        };

        await transporter.sendMail(mailOptions);

        console.log(`✅ Codice sconto ${newCode.code} generato e inviato a ${email}`);

        res.json({
            success: true,
            message: 'Discount code sent successfully',
            code: newCode.code,
            email: email
        });

    } catch (error) {
        console.error('Errore invio email discount:', error);
        res.status(500).json({
            error: 'Errore nell\'invio dell\'email',
            details: error.message
        });
    }
});

app.post('/api/validate-discount', async (req, res) => {
    try {
        const { code, amount } = req.body;
        if (!code) return res.status(400).json({ error: 'Codice sconto richiesto' });

        const originalAmount = amount || 15000;
        const result = calculateDiscountedPrice(originalAmount, code);

        if (!result.valid) return res.status(400).json({ error: result.error });

        console.log('Codice sconto validato:', code, result);
        res.json({
            valid: true, originalPrice: result.originalPrice, discountAmount: result.discountAmount,
            finalPrice: result.finalPrice, discountCode: result.discountCode,
            description: result.discountDescription, savings: `€${(result.discountAmount / 100).toFixed(2)}`
        });
    } catch (error) {
        console.error('Errore validazione codice sconto:', error);
        res.status(500).json({ error: 'Errore nella validazione del codice sconto' });
    }
});

// ===== ENDPOINTS STRIPE =====
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { email, name, phone, company, appointmentDate, appointmentTime, discountCode } = req.body;
        if (!email || !name) return res.status(400).json({ error: 'Email e nome sono richiesti' });
        if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe secret key not configured');

        let originalAmount = 15000;
        let finalAmount = originalAmount;
        let discountInfo = null;

        if (discountCode) {
            const discountResult = calculateDiscountedPrice(originalAmount, discountCode);
            if (!discountResult.valid) return res.status(400).json({ error: discountResult.error });

            finalAmount = discountResult.finalPrice;
            discountInfo = {
                code: discountResult.discountCode, description: discountResult.discountDescription,
                originalAmount: discountResult.originalPrice, discountAmount: discountResult.discountAmount,
                finalAmount: discountResult.finalPrice
            };
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: finalAmount, currency: 'eur', automatic_payment_methods: { enabled: true },
            metadata: {
                email, name, phone: phone || '', company: company || '',
                product: 'vfx-consultation', productId: 'cons-001',
                appointmentDate: appointmentDate || '',
                appointmentTime: appointmentTime || '',
                originalAmount: originalAmount.toString(), discountCode: discountCode || '',
                discountAmount: discountInfo ? discountInfo.discountAmount.toString() : '0',
                finalAmount: finalAmount.toString()
            },
            description: 'VFX Career Consultation with Valentin Procida'
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            discountInfo
        });
    } catch (error) {
        console.error('Errore creazione payment intent:', error);
        res.status(500).json({ error: 'Errore nel processare il pagamento', details: error.message });
    }
});

app.post('/api/booking-confirmation', async (req, res) => {
    try {
        const bookingData = req.body;

        await saveBookingToGoogleSheets(bookingData);

        const meetingInfo = await createGoogleMeetEvent(bookingData);

        if (transporter) {
            const customerMailOptions = {
                from: {
                    name: 'Valentin Procida',
                    address: process.env.EMAIL_USER
                },
                to: bookingData.customerEmail || bookingData.email,
                subject: '✅ Consulenza VFX Confermata - Valentin Procida',
                html: createBookingConfirmationTemplate(bookingData)
            };

            await transporter.sendMail(customerMailOptions);
            console.log('📧 Email di conferma inviata al cliente');

            if (meetingInfo) {
                scheduleReminderEmail(bookingData, meetingInfo);
            }
        }

        if (transporter && process.env.ADMIN_EMAIL) {
            const adminMailOptions = {
                from: {
                    name: 'Sistema Prenotazioni',
                    address: process.env.EMAIL_USER
                },
                to: process.env.ADMIN_EMAIL,
                subject: `🎯 Nuova Prenotazione: ${bookingData.customerName || bookingData.name} - ${bookingData.appointmentDate || 'Data da confermare'}`,
                html: createAdminNotificationTemplate(bookingData)
            };

            await transporter.sendMail(adminMailOptions);
            console.log('📧 Notifica admin inviata');
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Errore in booking confirmation:', error);
        res.status(500).json({ error: 'Failed to process booking confirmation' });
    }
});

// ===== WEBHOOK STRIPE =====
app.post('/api/stripe-webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        if (!endpointSecret) {
            console.log('Webhook ricevuto ma endpoint secret non configurato');
            return res.status(200).json({ received: true });
        }

        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
        console.log('Webhook evento ricevuto:', event.type);

    } catch (err) {
        console.error('Webhook signature verification fallita:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log('💰 Pagamento completato!', {
                id: paymentIntent.id,
                email: paymentIntent.metadata.email,
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                discountCode: paymentIntent.metadata.discountCode || 'Nessuno'
            });

            if (paymentIntent.metadata.discountCode) {
                const discount = discountCodes[paymentIntent.metadata.discountCode.toUpperCase()];
                if (discount) {
                    discount.usedCount++;
                    console.log(`Codice ${paymentIntent.metadata.discountCode} utilizzato. Nuovo conteggio: ${discount.usedCount}`);
                }

                const savings = parseInt(paymentIntent.metadata.discountAmount) / 100;
                console.log(`🎉 Cliente ha risparmiato €${savings.toFixed(2)} con il codice ${paymentIntent.metadata.discountCode}`);
            }

            const bookingData = {
                customerName: paymentIntent.metadata.name,
                customerEmail: paymentIntent.metadata.email,
                customerPhone: paymentIntent.metadata.phone,
                company: paymentIntent.metadata.company,
                appointmentDate: paymentIntent.metadata.appointmentDate,
                appointmentTime: paymentIntent.metadata.appointmentTime,
                amount: paymentIntent.amount,
                paymentIntent: paymentIntent.id,
                discount: paymentIntent.metadata.discountCode ? {
                    code: paymentIntent.metadata.discountCode,
                    discountAmount: parseInt(paymentIntent.metadata.discountAmount)
                } : null,
                timestamp: new Date().toISOString()
            };

            await saveBookingToGoogleSheets(bookingData);

            const meetingInfo = await createGoogleMeetEvent(bookingData);

            if (transporter) {
                try {
                    const customerMailOptions = {
                        from: {
                            name: 'Valentin Procida',
                            address: process.env.EMAIL_USER
                        },
                        to: bookingData.customerEmail,
                        subject: '✅ Consulenza VFX Confermata - Valentin Procida',
                        html: createBookingConfirmationTemplate(bookingData)
                    };

                    await transporter.sendMail(customerMailOptions);
                    console.log('📧 Email di conferma automatica inviata al cliente');

                    if (meetingInfo) {
                        scheduleReminderEmail(bookingData, meetingInfo);
                    }

                    if (process.env.ADMIN_EMAIL) {
                        const adminMailOptions = {
                            from: {
                                name: 'Sistema Prenotazioni',
                                address: process.env.EMAIL_USER
                            },
                            to: process.env.ADMIN_EMAIL,
                            subject: `🎯 Nuova Prenotazione: ${bookingData.customerName} - ${bookingData.appointmentDate || 'Data da confermare'}`,
                            html: createAdminNotificationTemplate(bookingData)
                        };

                        await transporter.sendMail(adminMailOptions);
                        console.log('📧 Notifica admin automatica inviata');
                    }
                } catch (emailError) {
                    console.error('Errore invio email automatica:', emailError);
                }
            }
            break;

        case 'payment_intent.payment_failed':
            const failedPayment = event.data.object;
            console.log('❌ Pagamento fallito:', {
                id: failedPayment.id,
                error: failedPayment.last_payment_error?.message,
                discountCode: failedPayment.metadata.discountCode || 'Nessuno'
            });
            break;

        default:
            console.log(`Evento non gestito: ${event.type}`);
    }

    res.json({ received: true });
});

// ===== ENDPOINT TEST EMAIL GOOGLE MEET =====
app.post('/api/test-google-meet-email', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Email richiesta per il test' });
        }

        if (!transporter) {
            return res.status(500).json({ error: 'Servizio email non configurato' });
        }

        // Crea dati di test
        const testBookingData = {
            customerName: 'Test Cliente',
            customerEmail: email,
            customerPhone: '+39 123 456 7890',
            company: 'Test Company',
            appointmentDate: '2025-07-18', // Domani
            appointmentTime: '15:30',
            amount: 15000,
            paymentIntent: 'pi_test_123456789'
        };

        // Crea meetingInfo di test
        const testMeetingInfo = {
            eventId: 'test-event-123',
            meetLink: 'https://meet.google.com/test-link-123',
            eventLink: 'https://calendar.google.com/event?eid=test',
            startTime: new Date('2025-07-18T15:30:00'),
            endTime: new Date('2025-07-18T17:00:00')
        };

        console.log('📧 Test invio email Google Meet a:', email);

        await sendMeetingLinkEmail(testBookingData, testMeetingInfo);

        res.json({
            success: true,
            message: 'Email di test Google Meet inviata con successo',
            recipient: email
        });

    } catch (error) {
        console.error('Errore test email Google Meet:', error);
        res.status(500).json({
            error: 'Errore nel test email',
            details: error.message
        });
    }
});

// ===== ENDPOINT FORZA INVIO EMAIL GOOGLE MEET =====
app.post('/api/force-google-meet-email', async (req, res) => {
    try {
        const { paymentIntentId } = req.body;

        if (!paymentIntentId) {
            return res.status(400).json({ error: 'paymentIntentId richiesto' });
        }

        // Simula i dati della prenotazione
        // In un caso reale dovresti recuperarli dal database o da Stripe
        const mockBookingData = {
            customerName: 'Cliente Test',
            customerEmail: 'test@example.com', // Cambia con l'email reale
            customerPhone: '+39 123 456 7890',
            appointmentDate: '2025-07-18',
            appointmentTime: '15:30',
            amount: 15000,
            paymentIntent: paymentIntentId
        };

        console.log('🚀 Tentativo forzato creazione Google Meet per:', paymentIntentId);

        // Prova a creare l'evento Google Meet
        const meetingInfo = await createGoogleMeetEvent(mockBookingData);

        if (meetingInfo) {
            // Invia immediatamente l'email
            await sendMeetingLinkEmail(mockBookingData, meetingInfo);

            res.json({
                success: true,
                message: 'Google Meet creato e email inviata con successo',
                meetLink: meetingInfo.meetLink,
                eventId: meetingInfo.eventId
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Impossibile creare evento Google Meet'
            });
        }

    } catch (error) {
        console.error('Errore force Google Meet:', error);
        res.status(500).json({
            error: 'Errore nella creazione forzata Google Meet',
            details: error.message
        });
    }
});

// ===== ALTRI ENDPOINTS =====
app.get('/api/discount-stats', (req, res) => {
    const stats = Object.entries(discountCodes).map(([code, data]) => ({
        code, description: data.description, type: data.type, value: data.value,
        active: data.active, usedCount: data.usedCount, maxUses: data.maxUses,
        remainingUses: data.maxUses ? data.maxUses - data.usedCount : 'Unlimited',
        validUntil: data.validUntil, assignedTo: data.assignedTo || null,
        isExpired: data.validUntil ? new Date() > data.validUntil : false
    }));

    const generatorStats = codeGenerator.getStats();

    res.json({
        discountCodes: stats, totalCodes: Object.keys(discountCodes).length,
        generatorStats: generatorStats,
        summary: {
            activeCodes: stats.filter(s => s.active && !s.isExpired).length,
            expiredCodes: stats.filter(s => s.isExpired).length,
            unlimitedCodes: stats.filter(s => !s.maxUses).length,
            emailCodes: stats.filter(s => s.assignedTo).length,
            totalUsages: stats.reduce((sum, s) => sum + s.usedCount, 0)
        }
    });
});

app.use(/^\/api\/.*/, (req, res) => {
    res.status(404).json({
        error: 'API endpoint not found',
        path: req.path,
        availableEndpoints: [
            'GET /api/health',
            'GET /api/config',
            'GET /ping',
            'GET /api/test-keepalive',
            'POST /api/test-google-meet-email',
            'POST /api/force-google-meet-email',
            'POST /api/send-discount-email',
            'POST /api/validate-discount',
            'POST /api/create-payment-intent',
            'POST /api/booking-confirmation',
            'GET /api/discount-stats',
            'POST /api/stripe-webhook'
        ]
    });
});

// ===== INIZIALIZZAZIONE =====
async function startServer() {
    try {
        await initGoogleServices();
        generateInitialCodes();

        if (transporter) {
            transporter.verify((error, success) => {
                if (error) {
                    console.error('❌ Errore configurazione email:', error.message);
                } else {
                    console.log('📧 Server email configurato correttamente');
                }
            });
        }

        setInterval(() => {
            let deactivatedCount = 0;
            const now = new Date();

            Object.entries(discountCodes).forEach(([code, data]) => {
                if (data.validUntil && now > data.validUntil && data.active) {
                    data.active = false;
                    deactivatedCount++;
                }
            });

            if (deactivatedCount > 0) {
                console.log(`🧹 Cleanup automatico: ${deactivatedCount} codici scaduti disattivati`);
            }
        }, 60 * 60 * 1000);

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server running on port ${PORT}`);
            console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
            console.log(`📧 Email configured: ${!!transporter}`);
            console.log(`📊 Google Sheets configured: ${!!sheets}`);
            console.log(`📅 Google Calendar configured: ${!!calendar}`);
            console.log(`🎫 Codici sconto disponibili: ${Object.keys(discountCodes).length}`);
            console.log(`🏓 Keep-alive attivo: ${process.env.NODE_ENV === 'production'}`);
            console.log(`🌐 Server ready at: http://localhost:${PORT}`);

            console.log('\n🎯 Codici sconto disponibili:');
            Object.entries(discountCodes).slice(0, 5).forEach(([code, data]) => {
                console.log(`- ${code}: ${data.description}`);
            });
            console.log(`... e altri ${Math.max(0, Object.keys(discountCodes).length - 5)} codici\n`);

            if (process.env.NODE_ENV === 'production') {
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log('🏓 KEEP-ALIVE SYSTEM STATUS');
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                console.log(`🌐 Render URL: ${RENDER_URL}`);
                console.log(`⏰ Ping interval: Every 12 minutes`);
                console.log(`🔧 Cron available: ${!!cron}`);
                console.log(`🐛 Debug mode: ${process.env.DEBUG_KEEPALIVE === 'true' ? 'ENABLED' : 'DISABLED'}`);
                console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

                if (!RENDER_URL || RENDER_URL.includes('localhost')) {
                    console.log('⚠️  WARNING: RENDER_URL not configured! Keep-alive will not work.');
                    console.log('   🔧 Set RENDER_URL environment variable to your Render app URL');
                    console.log('   📝 Example: https://your-app-name.onrender.com');
                    console.log('   ⚙️  Go to Render Dashboard > Environment > Add Environment Variable:');
                    console.log('      Variable: RENDER_URL');
                    console.log('      Value: https://your-app-name.onrender.com');
                    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
                } else {
                    // Test immediato del keep-alive solo se RENDER_URL è configurato
                    setTimeout(() => {
                        console.log('🧪 Testing keep-alive system in 5 seconds...');
                        keepServerAlive();
                    }, 5000);
                }
            }
        });

    } catch (error) {
        console.error('❌ Errore durante l\'avvio del server:', error);
        process.exit(1);
    }
}

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

startServer();
