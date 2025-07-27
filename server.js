// server.js - Sistema completo con Google Meet, email eleganti, Google Sheets, Keep-Alive e Anti-Doppie Prenotazioni
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

// ===== FUNZIONI PER GESTIRE SLOT PRENOTATI (ANTI-DOPPIE PRENOTAZIONI) =====

/**
 * Recupera tutte le prenotazioni esistenti da Google Sheets
 */
async function getExistingBookings() {
    if (!sheets || !process.env.GOOGLE_SPREADSHEET_ID) {
        console.warn('⚠️ Google Sheets non configurato - nessun controllo prenotazioni esistenti');
        return [];
    }

    try {
        const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;
        
        // Legge tutte le righe dalla colonna A alla K
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Prenotazioni!A:K'
        });

        const rows = response.data.values || [];
        
        // Salta la riga dell'header (prima riga)
        const bookingRows = rows.slice(1);
        
        const existingBookings = [];
        
        bookingRows.forEach((row, index) => {
            // Struttura: [Timestamp, Nome, Email, Telefono, Azienda, Data, Orario, Prezzo, Sconto, PaymentID, Stato]
            if (row.length >= 7) {
                const rawDate = row[5]; // Data
                const time = row[6];    // Orario
                const status = row[10]; // Stato
                
                // Solo prenotazioni confermate
                if (status === 'Confermata' && rawDate && time) {
                    // Converte la data dal formato italiano (dd/mm/yyyy) al formato ISO (yyyy-mm-dd)
                    const dateFormatted = convertItalianDateToISO(rawDate);
                    
                    if (dateFormatted) {
                        existingBookings.push({
                            date: dateFormatted,
                            time: time.trim(),
                            customerName: row[1] || '',
                            rowIndex: index + 2 // +2 perché spreadsheet inizia da 1 e abbiamo saltato l'header
                        });
                    }
                }
            }
        });

        console.log(`📊 Trovate ${existingBookings.length} prenotazioni esistenti in Google Sheets`);
        return existingBookings;

    } catch (error) {
        console.error('❌ Errore recupero prenotazioni esistenti:', error.message);
        return [];
    }
}

/**
 * Converte data dal formato italiano (dd/mm/yyyy) al formato ISO (yyyy-mm-dd)
 */
function convertItalianDateToISO(italianDate) {
    try {
        // Gestisce formati: "18/7/2025", "18/07/2025", "venerdì 18 luglio 2025"
        
        // Se contiene testo (giorno della settimana), estrai solo la parte numerica
        const dateMatch = italianDate.match(/(\d{1,2})[\s\/](\d{1,2})[\s\/](\d{4})/);
        
        if (dateMatch) {
            const [, day, month, year] = dateMatch;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
        
        // Prova parsing diretto
        const parts = italianDate.split('/');
        if (parts.length === 3) {
            const [day, month, year] = parts;
            return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        }
        
        return null;
    } catch (error) {
        console.error('❌ Errore conversione data:', italianDate, error);
        return null;
    }
}

/**
 * Controlla se uno slot specifico è già prenotato
 */
async function isSlotBooked(date, time) {
    const existingBookings = await getExistingBookings();
    
    return existingBookings.some(booking => 
        booking.date === date && booking.time === time
    );
}

/**
 * Genera slot disponibili escludendo quelli già prenotati
 */
async function getAvailableSlots() {
    try {
        // Ottieni tutte le prenotazioni esistenti
        const existingBookings = await getExistingBookings();
        
        // Genera tutti i possibili slot (stesso algoritmo del frontend)
        const allSlots = generateAllPossibleSlots();
        
        // Filtra gli slot già prenotati
        const availableSlots = {};
        
        Object.entries(allSlots).forEach(([date, times]) => {
            const availableTimes = times.filter(time => {
                return !existingBookings.some(booking => 
                    booking.date === date && booking.time === time
                );
            });
            
            // Solo se ci sono orari disponibili, includi la data
            if (availableTimes.length > 0) {
                availableSlots[date] = availableTimes;
            }
        });
        
        console.log(`📅 Slot disponibili calcolati: ${Object.keys(availableSlots).length} date disponibili`);
        return availableSlots;
        
    } catch (error) {
        console.error('❌ Errore calcolo slot disponibili:', error);
        // Fallback: restituisci tutti gli slot possibili
        return generateAllPossibleSlots();
    }
}

/**
 * Genera tutti i possibili slot (stessa logica del frontend)
 */
function generateAllPossibleSlots() {
    const allSlots = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i <= 60; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);

        // Salta weekend
        if (date.getDay() === 0 || date.getDay() === 6) continue;
        
        // Salta festività italiane
        if (isItalianHoliday(date)) continue;

        // Se è oggi, salta se è troppo tardi
        if (i === 0) {
            const now = new Date();
            if (now.getHours() >= 17) {
                continue;
            }
        }

        const dateStr = formatDateToLocalString(date);
        const morningSlots = ['09:00', '10:30'];
        const afternoonSlots = ['14:00', '15:30', '17:00'];
        const slots = [...morningSlots, ...afternoonSlots];

        allSlots[dateStr] = slots;
    }

    return allSlots;
}

function isItalianHoliday(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    const fixedHolidays = [
        { month: 1, day: 1 }, { month: 1, day: 6 }, { month: 4, day: 25 },
        { month: 5, day: 1 }, { month: 6, day: 2 }, { month: 8, day: 15 },
        { month: 11, day: 1 }, { month: 12, day: 8 }, { month: 12, day: 25 }, { month: 12, day: 26 }
    ];

    for (const holiday of fixedHolidays) {
        if (month === holiday.month && day === holiday.day) return true;
    }

    const easter = calculateEaster(year);
    const easterMonday = new Date(easter);
    easterMonday.setDate(easter.getDate() + 1);

    return date.toDateString() === easter.toDateString() ||
        date.toDateString() === easterMonday.toDateString();
}

function calculateEaster(year) {
    const f = Math.floor;
    const G = year % 19;
    const C = f(year / 100);
    const H = (C - f(C / 4) - f((8 * C + 13) / 25) + 19 * G + 15) % 30;
    const I = H - f(H / 28) * (1 - f(29 / (H + 1)) * f((21 - G) / 11));
    const J = (year + f(year / 4) + I + 2 - C + f(C / 4)) % 7;
    const L = I - J;
    const month = 3 + f((L + 40) / 44);
    const day = L + 28 - 31 * f(month / 4);

    return new Date(year, month - 1, day);
}

function formatDateToLocalString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
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
    transporter = nodemailer.createTransporter(emailConfig);
    console.log('📧 Email transporter configurato');
}

// ===== EMAIL TEMPLATES =====
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
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; background: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: #2c3e50; padding: 40px 30px; text-align: center;">
            <div style="width: 60px; height: 60px; background: #27ae60; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 28px; color: white;">✓</div>
            <h1 style="margin: 0; font-size: 28px; font-weight: 300; color: white;">Prenotazione Confermata</h1>
            <p style="margin: 15px 0 0 0; color: #bdc3c7; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Consulenza VFX • Valentin Procida</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px 30px;">
            
            <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 24px; font-weight: 400;">Ciao ${bookingData.customerName || bookingData.name}!</h2>
                <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 0;">
                    La tua consulenza VFX è stata confermata con successo.<br>
                    <strong style="color: #2c3e50;">Riceverai il link Google Meet in una email separata tra pochi minuti.</strong>
                </p>
            </div>
            
            <!-- Appointment Details -->
            <div style="background: #f8f9fa; border: 1px solid #e9ecef; padding: 30px; margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #3498db; padding-bottom: 10px;">📅 Dettagli Appuntamento</h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500; width: 35%;">Data:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">${formattedDate}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Orario:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">${bookingData.appointmentTime || 'Da confermare'}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Durata:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">90 minuti</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Modalità:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">Video chiamata Google Meet</td>
                    </tr>
                </table>
            </div>
            
            <!-- Payment Summary -->
            <div style="background: #e8f5e9; border: 1px solid #c3e6cb; padding: 30px; margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #27ae60; padding-bottom: 10px;">💳 Riepilogo Pagamento</h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid #c3e6cb;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Consulenza VFX:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 700; font-size: 18px; text-align: right;">€${finalAmount}</td>
                    </tr>
                    ${bookingData.discount ? `
                    <tr style="border-bottom: 1px solid #c3e6cb;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Sconto ${bookingData.discount.code}:</td>
                        <td style="padding: 12px 0; color: #27ae60; font-weight: 600; text-align: right;">Applicato ✓</td>
                    </tr>` : ''}
                    <tr>
                        <td colspan="2" style="padding: 15px 0 0 0; color: #666; font-size: 12px;">
                            <strong>ID Transazione:</strong> ${bookingData.paymentIntent || bookingData.paymentId}
                        </td>
                    </tr>
                </table>
            </div>
            
            <!-- Google Meet Notice -->
            <div style="background: #2c3e50; color: white; padding: 30px; text-align: center; margin-bottom: 30px;">
                <div style="width: 50px; height: 50px; background: #3498db; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; font-size: 20px;">🎥</div>
                <h3 style="color: white; margin: 0 0 15px 0; font-size: 18px; font-weight: 500;">Link Google Meet in Arrivo</h3>
                <p style="margin: 0; font-size: 16px; line-height: 1.5;">
                    Ti invieremo il link per la video chiamata in una <strong>email separata tra pochi minuti</strong>.<br>
                    Controlla la tua casella di posta!
                </p>
            </div>
            
            <!-- Support -->
            <div style="text-align: center; padding: 25px; background: #f8f9fa; border: 1px solid #e9ecef;">
                <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.5;">
                    Hai domande? Rispondi pure a questa email.<br>
                    <strong style="color: #2c3e50;">Ci sentiamo presto!</strong>
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #34495e; color: white; padding: 30px; text-align: center;">
            <div style="margin-bottom: 10px;">
                <strong style="font-size: 18px;">Valentin Procida</strong>
            </div>
            <div style="color: #bdc3c7; font-size: 14px; line-height: 1.4;">
                VFX Artist & Career Consultant<br>
                <a href="https://www.valentinprocida.it" style="color: #3498db; text-decoration: none;">www.valentinprocida.it</a>
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
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; background: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: #27ae60; padding: 40px 30px; text-align: center;">
            <div style="width: 60px; height: 60px; background: white; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 28px;">🎥</div>
            <h1 style="margin: 0; font-size: 28px; font-weight: 300; color: white;">Google Meet Pronto!</h1>
            <p style="margin: 15px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Il tuo link è qui sotto</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px 30px;">
            
            <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 24px; font-weight: 400;">Ciao ${bookingData.customerName}!</h2>
                <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 0;">
                    La tua prenotazione è completa! Usa il link qui sotto per unirti alla video chiamata.<br>
                    <strong style="color: #2c3e50;">Salva questa email.</strong>
                </p>
            </div>
            
            <!-- Google Meet Link prominente -->
            <div style="background: #2c3e50; padding: 40px 30px; text-align: center; margin-bottom: 40px;">
                <h3 style="margin: 0 0 25px 0; color: white; font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px;">🔗 Link Video Chiamata</h3>
                <a href="${meetingInfo.meetLink}" 
                   style="background: white; color: #2c3e50; padding: 15px 30px; text-decoration: none; 
                          font-weight: 600; font-size: 16px; display: inline-block; 
                          text-transform: uppercase; letter-spacing: 1px; border-radius: 5px;">
                    🎥 Unisciti alla Chiamata
                </a>
                <p style="margin: 20px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">
                    Clicca 5-10 minuti prima dell'appuntamento
                </p>
            </div>
            
            <!-- Meeting Schedule -->
            <div style="background: #f8f9fa; border: 1px solid #e9ecef; padding: 30px; margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #27ae60; padding-bottom: 10px;">📅 Programma</h3>
                
                <table style="width: 100%; border-collapse: collapse;">
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500; width: 35%;">Data:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">${formattedDate}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Orario:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">${startTime} - ${endTime}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e9ecef;">
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Fuso Orario:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">Europe/Rome (GMT+1)</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 0; color: #666; font-weight: 500;">Durata:</td>
                        <td style="padding: 12px 0; color: #2c3e50; font-weight: 600;">90 minuti</td>
                    </tr>
                </table>
            </div>
            
            <!-- Support -->
            <div style="text-align: center; padding: 25px; background: #fff3cd; border: 1px solid #ffeaa7;">
                <p style="margin: 0; color: #666; font-size: 14px; line-height: 1.5;">
                    <strong style="color: #2c3e50;">Problemi tecnici?</strong><br>
                    Contattami subito: 
                    <a href="mailto:${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}" style="color: #e17055; text-decoration: none; font-weight: 600;">
                        ${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}
                    </a>
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #34495e; color: white; padding: 30px; text-align: center;">
            <div style="margin-bottom: 10px;">
                <strong style="font-size: 18px;">Valentin Procida</strong>
            </div>
            <div style="color: #bdc3c7; font-size: 14px; line-height: 1.4;">
                VFX Artist & Career Consultant<br>
                <a href="https://www.valentinprocida.it" style="color: #3498db; text-decoration: none;">www.valentinprocida.it</a>
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
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; background: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: #e74c3c; padding: 40px 30px; text-align: center;">
            <div style="width: 60px; height: 60px; background: white; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; font-size: 28px;">🎉</div>
            <h1 style="margin: 0; font-size: 28px; font-weight: 300; color: white;">Your Discount is Ready!</h1>
            <p style="margin: 15px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Exclusive ${discountAmount}% VFX Consultation Discount</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px 30px;">
            
            <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 24px; font-weight: 400;">${name ? `Hi ${name}!` : 'Hello!'}</h2>
                <p style="color: #555; font-size: 16px; line-height: 1.6; margin: 0;">
                    Thank you for your interest in my VFX consultation services!<br>
                    <strong style="color: #2c3e50;">Here's your exclusive discount code:</strong>
                </p>
            </div>
            
            <!-- Discount Code prominente -->
            <div style="background: #2c3e50; padding: 40px 30px; text-align: center; margin-bottom: 40px;">
                <p style="color: rgba(255,255,255,0.9); margin: 0 0 15px 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600;">Your Discount Code</p>
                <div style="background: white; color: #2c3e50; padding: 20px; margin: 20px 0; font-size: 32px; font-weight: 700; letter-spacing: 4px; font-family: 'Courier New', monospace; border-radius: 5px; border: 3px solid #e74c3c;">${discountCode}</div>
                <p style="color: white; margin: 15px 0 0 0; font-size: 18px; font-weight: 500;">Save ${discountAmount}% on your VFX consultation</p>
            </div>
            
            <!-- CTA Button -->
            <div style="text-align: center; margin-bottom: 40px;">
                <a href="https://www.valentinprocida.it/buy.html" 
                   style="background: #e74c3c; color: white; padding: 15px 35px; text-decoration: none; 
                          font-weight: 600; font-size: 16px; display: inline-block;
                          text-transform: uppercase; letter-spacing: 1px; border-radius: 5px;">
                    🚀 Book Your Consultation Now
                </a>
                <p style="color: #666; margin: 15px 0 0 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">
                    Limited time offer
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #34495e; color: white; padding: 30px; text-align: center;">
            <div style="margin-bottom: 15px;">
                <h3 style="margin: 0 0 5px 0; font-size: 16px; font-weight: 500;">Best regards,</h3>
                <strong style="font-size: 20px; font-weight: 600;">Valentin Procida</strong>
            </div>
            <div style="color: #bdc3c7; font-size: 14px; line-height: 1.4; margin-bottom: 20px;">
                VFX Artist & Rigger
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
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333;">
    <div style="max-width: 600px; margin: 0 auto; background: white; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        
        <!-- Header Admin -->
        <div style="background: #9b59b6; padding: 30px; text-align: center;">
            <div style="width: 50px; height: 50px; background: white; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; font-size: 20px;">🎯</div>
            <h1 style="margin: 0; font-size: 24px; font-weight: 600; color: white;">Nuova Prenotazione</h1>
            <p style="margin: 10px 0 0 0; color: rgba(255,255,255,0.9); font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Sistema VFX Booking</p>
        </div>
        
        <!-- Content Admin -->
        <div style="padding: 30px;">
            
            <!-- Customer Section -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #9b59b6; padding-bottom: 8px;">👤 Cliente</h3>
                
                <div style="background: #f8f9fa; border-left: 4px solid #9b59b6; padding: 20px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr style="border-bottom: 1px solid #e9ecef;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500; width: 30%;">Nome:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 600;">${bookingData.customerName || bookingData.name}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #e9ecef;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Email:</td>
                            <td style="padding: 8px 0;"><a href="mailto:${bookingData.customerEmail || bookingData.email}" style="color: #9b59b6; text-decoration: none; font-weight: 500;">${bookingData.customerEmail || bookingData.email}</a></td>
                        </tr>
                        <tr style="border-bottom: 1px solid #e9ecef;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Telefono:</td>
                            <td style="padding: 8px 0;"><a href="tel:${bookingData.customerPhone || bookingData.phone}" style="color: #9b59b6; text-decoration: none; font-weight: 500;">${bookingData.customerPhone || bookingData.phone}</a></td>
                        </tr>
                        ${bookingData.company ? `
                        <tr>
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Azienda:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 600;">${bookingData.company}</td>
                        </tr>` : ''}
                    </table>
                </div>
            </div>
            
            <!-- Appointment Section -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #3498db; padding-bottom: 8px;">📅 Appuntamento</h3>
                
                <div style="background: #e3f2fd; border-left: 4px solid #3498db; padding: 20px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr style="border-bottom: 1px solid #bbdefb;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500; width: 30%;">Data:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 600;">${formattedDate}</td>
                        </tr>
                        <tr style="border-bottom: 1px solid #bbdefb;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Orario:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 600;">${bookingData.appointmentTime || 'Non specificato'}</td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Durata:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 600;">90 minuti</td>
                        </tr>
                    </table>
                </div>
            </div>
            
            <!-- Payment Section -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-bottom: 2px solid #27ae60; padding-bottom: 8px;">💰 Pagamento</h3>
                
                <div style="background: #e8f5e9; border-left: 4px solid #27ae60; padding: 20px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr style="border-bottom: 1px solid #c3e6cb;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500; width: 30%;">Importo:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 700; font-size: 18px;">€${finalAmount}</td>
                        </tr>
                        ${bookingData.discount ? `
                        <tr style="border-bottom: 1px solid #c3e6cb;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Sconto:</td>
                            <td style="padding: 8px 0; color: #27ae60; font-weight: 600;">${bookingData.discount.code} (-€${(bookingData.discount.discountAmount / 100).toFixed(2)})</td>
                        </tr>` : ''}
                        <tr style="border-bottom: 1px solid #c3e6cb;">
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">ID Stripe:</td>
                            <td style="padding: 8px 0;"><code style="background: #f8f9fa; padding: 4px 8px; border-radius: 3px; font-size: 12px; color: #2c3e50;">${bookingData.paymentIntent || bookingData.paymentId}</code></td>
                        </tr>
                        <tr>
                            <td style="padding: 8px 0; color: #666; font-weight: 500;">Timestamp:</td>
                            <td style="padding: 8px 0; color: #2c3e50; font-weight: 500;">${new Date().toLocaleString('it-IT')}</td>
                        </tr>
                    </table>
                </div>
            </div>
            
        </div>
        
        <!-- Footer Admin -->
        <div style="background: #34495e; color: white; padding: 20px; text-align: center;">
            <p style="margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #bdc3c7;">
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
app.get('/api/health', async (req, res) => {
    let availabilityStatus = 'unknown';
    let totalBookings = 0;
    let availableDatesCount = 0;
    
    try {
        // Test rapido del sistema di disponibilità
        const existingBookings = await getExistingBookings();
        totalBookings = existingBookings.length;
        
        const availableSlots = await getAvailableSlots();
        availableDatesCount = Object.keys(availableSlots).length;
        
        availabilityStatus = 'working';
    } catch (error) {
        availabilityStatus = 'error: ' + error.message;
    }
    
    res.json({
        status: 'Server is running!',
        timestamp: new Date(),
        
        // Configurazioni esistenti
        totalDiscountCodes: Object.keys(discountCodes).length,
        emailConfigured: !!transporter,
        googleSheetsConfigured: !!sheets,
        googleCalendarConfigured: !!calendar,
        
        // 🔥 NUOVO: Informazioni sistema disponibilità
        availabilitySystem: {
            status: availabilityStatus,
            totalExistingBookings: totalBookings,
            availableDatesCount: availableDatesCount,
            googleSheetsIntegration: !!sheets && !!process.env.GOOGLE_SPREADSHEET_ID,
            lastChecked: new Date().toISOString()
        },
        
        // Info sistema
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

// ===== NUOVI ENDPOINT API PER GESTIRE DISPONIBILITÀ =====

/**
 * Endpoint per ottenere tutti gli slot disponibili
 */
app.get('/api/available-slots', async (req, res) => {
    try {
        console.log('📅 Richiesta slot disponibili ricevuta');
        
        const availableSlots = await getAvailableSlots();
        
        res.json({
            success: true,
            availableSlots: availableSlots,
            totalDatesAvailable: Object.keys(availableSlots).length,
            generatedAt: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Errore recupero slot disponibili:', error);
        
        // Fallback: restituisci tutti i possibili slot
        const fallbackSlots = generateAllPossibleSlots();
        
        res.json({
            success: true,
            availableSlots: fallbackSlots,
            totalDatesAvailable: Object.keys(fallbackSlots).length,
            generatedAt: new Date().toISOString(),
            warning: 'Fallback utilizzato - controllo prenotazioni esistenti fallito'
        });
    }
});

/**
 * Endpoint per controllare la disponibilità di uno slot specifico
 */
app.post('/api/check-slot-availability', async (req, res) => {
    try {
        const { date, time } = req.body;
        
        if (!date || !time) {
            return res.status(400).json({
                success: false,
                error: 'Data e orario sono richiesti'
            });
        }
        
        console.log(`🔍 Controllo disponibilità slot: ${date} alle ${time}`);
        
        const isBooked = await isSlotBooked(date, time);
        
        res.json({
            success: true,
            available: !isBooked,
            date: date,
            time: time,
            checkedAt: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Errore controllo disponibilità slot:', error);
        res.status(500).json({
            success: false,
            error: 'Errore interno nel controllo disponibilità',
            details: error.message
        });
    }
});

/**
 * Endpoint per vedere tutte le prenotazioni esistenti (per debug/admin)
 */
app.get('/api/existing-bookings', async (req, res) => {
    try {
        const existingBookings = await getExistingBookings();
        
        res.json({
            success: true,
            bookings: existingBookings,
            totalBookings: existingBookings.length,
            retrievedAt: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Errore recupero prenotazioni esistenti:', error);
        res.status(500).json({
            success: false,
            error: 'Errore nel recupero delle prenotazioni esistenti',
            details: error.message
        });
    }
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
        
        if (!email || !name) {
            return res.status(400).json({ error: 'Email e nome sono richiesti' });
        }
        
        if (!appointmentDate || !appointmentTime) {
            return res.status(400).json({ error: 'Data e orario dell\'appuntamento sono richiesti' });
        }
        
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('Stripe secret key not configured');
        }

        // 🔥 NUOVO: Controlla se lo slot è ancora disponibile
        console.log(`🔍 Controllo finale disponibilità: ${appointmentDate} alle ${appointmentTime}`);
        
        const isBooked = await isSlotBooked(appointmentDate, appointmentTime);
        
        if (isBooked) {
            console.log(`❌ Slot ${appointmentDate} alle ${appointmentTime} già prenotato!`);
            return res.status(409).json({ 
                error: 'Questo slot è stato appena prenotato da un altro cliente. Seleziona un altro orario.',
                code: 'SLOT_ALREADY_BOOKED'
            });
        }
        
        console.log(`✅ Slot ${appointmentDate} alle ${appointmentTime} ancora disponibile, procedo con il pagamento`);

        let originalAmount = 15000;
        let finalAmount = originalAmount;
        let discountInfo = null;

        if (discountCode) {
            const discountResult = calculateDiscountedPrice(originalAmount, discountCode);
            if (!discountResult.valid) {
                return res.status(400).json({ error: discountResult.error });
            }

            finalAmount = discountResult.finalPrice;
            discountInfo = {
                code: discountResult.discountCode,
                description: discountResult.discountDescription,
                originalAmount: discountResult.originalPrice,
                discountAmount: discountResult.discountAmount,
                finalAmount: discountResult.finalPrice
            };
        }

        const paymentIntent = await stripe.paymentIntents.create({
            amount: finalAmount,
            currency: 'eur',
            automatic_payment_methods: { enabled: true },
            metadata: {
                email, name, phone: phone || '', company: company || '',
                product: 'vfx-consultation', productId: 'cons-001',
                appointmentDate: appointmentDate || '',
                appointmentTime: appointmentTime || '',
                originalAmount: originalAmount.toString(),
                discountCode: discountCode || '',
                discountAmount: discountInfo ? discountInfo.discountAmount.toString() : '0',
                finalAmount: finalAmount.toString()
            },
            description: 'VFX Career Consultation with Valentin Procida'
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id,
            discountInfo,
            slotVerified: true,
            verifiedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Errore creazione payment intent:', error);
        res.status(500).json({ 
            error: 'Errore nel processare il pagamento', 
            details: error.message 
        });
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

// ===== ENDPOINT 404 PER API =====
app.use(/^\/api\/.*/, (req, res) => {
    res.status(404).json({
        error: 'API endpoint not found',
        path: req.path,
        availableEndpoints: [
            'GET /api/health',
            'GET /api/config',
            'GET /ping',
            'GET /api/test-keepalive',
            'GET /api/available-slots',
            'POST /api/check-slot-availability',
            'GET /api/existing-bookings',
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

// ===== INIZIALIZZAZIONE SERVER =====
async function startServer() {
    try {
        // Inizializza tutti i servizi
        await initGoogleServices();
        generateInitialCodes();

        // Verifica configurazione email
        if (transporter) {
            transporter.verify((error, success) => {
                if (error) {
                    console.error('❌ Errore configurazione email:', error.message);
                } else {
                    console.log('📧 Server email configurato correttamente');
                }
            });
        }

        // Cleanup automatico codici scaduti ogni ora
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
        }, 60 * 60 * 1000); // Ogni ora

        // Avvia il server
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server running on port ${PORT}`);
            console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
            console.log(`📧 Email configured: ${!!transporter}`);
            console.log(`📊 Google Sheets configured: ${!!sheets}`);
            console.log(`📅 Google Calendar configured: ${!!calendar}`);
            console.log(`🎫 Codici sconto disponibili: ${Object.keys(discountCodes).length}`);
            console.log(`🏓 Keep-alive attivo: ${process.env.NODE_ENV === 'production'}`);
            console.log(`🛡️ Sistema anti-doppie prenotazioni: ${!!sheets ? 'ATTIVO' : 'FALLBACK LOCALE'}`);
            console.log(`🌐 Server ready at: http://localhost:${PORT}`);

            console.log('\n🎯 Codici sconto disponibili:');
            Object.entries(discountCodes).slice(0, 5).forEach(([code, data]) => {
                console.log(`- ${code}: ${data.description}`);
            });
            console.log(`... e altri ${Math.max(0, Object.keys(discountCodes).length - 5)} codici\n`);

            // Informazioni sistema di disponibilità
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🛡️ SISTEMA ANTI-DOPPIE PRENOTAZIONI');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`📊 Google Sheets: ${!!sheets ? 'CONFIGURATO' : 'NON CONFIGURATO'}`);
            console.log(`🔗 Spreadsheet ID: ${process.env.GOOGLE_SPREADSHEET_ID ? 'CONFIGURATO' : 'MANCANTE'}`);
            console.log(`✅ Controllo real-time: ATTIVO`);
            console.log(`🔒 Prevenzione race conditions: ATTIVA`);
            console.log(`🔄 Fallback locale: DISPONIBILE`);
            
            if (!sheets) {
                console.log('⚠️  WARNING: Google Sheets non configurato!');
                console.log('   🔧 Il sistema funzionerà con fallback locale');
                console.log('   📋 Per attivare il controllo completo:');
                console.log('      1. Configura GOOGLE_SERVICE_ACCOUNT_KEY');
                console.log('      2. Configura GOOGLE_SPREADSHEET_ID');
                console.log('      3. Crea tab "Prenotazioni" con headers corretti');
            }
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

            // Informazioni keep-alive (solo in produzione)
            if (process.env.NODE_ENV === 'production') {
                console.log('\n🏓 KEEP-ALIVE SYSTEM STATUS');
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

            // Test sistema disponibilità (solo se Google Sheets è configurato)
            if (sheets && process.env.GOOGLE_SPREADSHEET_ID) {
                setTimeout(async () => {
                    try {
                        console.log('\n🧪 Testing availability system...');
                        const existingBookings = await getExistingBookings();
                        const availableSlots = await getAvailableSlots();
                        console.log(`✅ Sistema disponibilità OK: ${existingBookings.length} prenotazioni, ${Object.keys(availableSlots).length} date disponibili`);
                    } catch (error) {
                        console.log(`⚠️ Test sistema disponibilità fallito: ${error.message}`);
                    }
                }, 3000);
            }
        });

    } catch (error) {
        console.error('❌ Errore durante l\'avvio del server:', error);
        process.exit(1);
    }
}

// ===== GESTIONE ERRORI =====
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

// ===== AVVIO SERVER =====
startServer();
