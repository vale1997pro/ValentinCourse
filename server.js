// server.js - Sistema completo con Google Meet, email eleganti e Google Sheets
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

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

    try {
        const appointmentDate = new Date(bookingData.appointmentDate);
        const [hours, minutes] = bookingData.appointmentTime.split(':');
        
        const startTime = new Date(appointmentDate);
        startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        
        const endTime = new Date(startTime);
        endTime.setMinutes(endTime.getMinutes() + 90);

        console.log('📅 Creazione evento Google Calendar:', {
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            customerName: bookingData.customerName,
            customerEmail: bookingData.customerEmail
        });

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

Argomenti da discutere:
- Analisi portfolio VFX
- Roadmap carriera personalizzata
- Strategie industria VFX
- CV e networking tips

NOTA: Cliente da contattare separatamente per il link Google Meet
            `.trim(),
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            // RIMOSSO: attendees - causa problemi con Service Account
            conferenceData: {
                createRequest: {
                    requestId: `meet-${Date.now()}`,
                    conferenceSolutionKey: {
                        type: 'hangoutsMeet'
                    }
                }
            },
            reminders: {
                useDefault: false,
                overrides: [
                    { method: 'email', minutes: 24 * 60 },
                    { method: 'email', minutes: 60 },
                    { method: 'popup', minutes: 10 }
                ]
            }
        };

        console.log('📅 Invio richiesta a Google Calendar API...');

        const createdEvent = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            conferenceDataVersion: 1,
            sendUpdates: 'none' // Non inviare aggiornamenti automatici
        });

        console.log('✅ Evento Google Calendar creato con successo:', {
            eventId: createdEvent.data.id,
            meetLink: createdEvent.data.hangoutLink,
            eventLink: createdEvent.data.htmlLink
        });

        const meetingInfo = {
            eventId: createdEvent.data.id,
            meetLink: createdEvent.data.hangoutLink,
            eventLink: createdEvent.data.htmlLink,
            startTime: startTime,
            endTime: endTime
        };

        console.log('🔗 Google Meet Link generato:', meetingInfo.meetLink);
        
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
    transporter = nodemailer.createTransport(emailConfig);
    console.log('📧 Email transporter configurato');
} else {
    console.warn('⚠️ Configurazione email mancante - le email non saranno inviate');
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
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
    <div style="max-width: 600px; margin: 0 auto; background: white;">
        
        <!-- Header -->
        <div style="background: #2c3e50; color: white; padding: 30px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">✅ Prenotazione Confermata</h1>
        </div>
        
        <!-- Content -->
        <div style="padding: 30px;">
            
            <h2 style="color: #2c3e50; margin-bottom: 20px;">Ciao ${bookingData.customerName || bookingData.name}!</h2>
            
            <p style="color: #555; line-height: 1.6; margin-bottom: 30px;">
                La tua consulenza VFX è stata confermata con successo. 
                Riceverai il link Google Meet 24 ore prima dell'appuntamento.
            </p>
            
            <!-- Appointment Details -->
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin-top: 0;">📅 Dettagli Appuntamento</h3>
                <p style="margin: 10px 0;"><strong>Data:</strong> ${formattedDate}</p>
                <p style="margin: 10px 0;"><strong>Orario:</strong> ${bookingData.appointmentTime || 'Da confermare'}</p>
                <p style="margin: 10px 0;"><strong>Durata:</strong> 90 minuti</p>
                <p style="margin: 10px 0;"><strong>Modalità:</strong> Video chiamata Google Meet</p>
            </div>
            
            <!-- Payment Details -->
            <div style="background: #e8f5e8; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin-top: 0;">💳 Pagamento</h3>
                <p style="margin: 10px 0;"><strong>Importo:</strong> €${finalAmount}</p>
                ${bookingData.discount ? `<p style="margin: 10px 0;"><strong>Sconto:</strong> ${bookingData.discount.code}</p>` : ''}
                <p style="margin: 10px 0; color: #666; font-size: 12px;"><strong>ID:</strong> ${bookingData.paymentIntent || bookingData.paymentId}</p>
            </div>
            
            <!-- What to Expect -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50;">🎯 Cosa Aspettarsi</h3>
                <ul style="color: #555; line-height: 1.6;">
                    <li>Analisi completa del tuo portfolio VFX</li>
                    <li>Roadmap personalizzata per la tua carriera</li>
                    <li>Strategie concrete per entrare nell'industria</li>
                    <li>Template CV e email ottimizzati</li>
                    <li>Risorse e contatti utili</li>
                    <li>Follow-up con materiali aggiuntivi</li>
                </ul>
            </div>
            
            <!-- Preparation -->
            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin-bottom: 30px;">
                <h3 style="color: #856404; margin-top: 0;">📋 Preparazione</h3>
                <p style="color: #856404; margin-bottom: 15px;">Per massimizzare il valore della consulenza:</p>
                <ul style="color: #856404; line-height: 1.6;">
                    <li>Prepara il tuo portfolio/reel più recente</li>
                    <li>Elenca le tue domande specifiche</li>
                    <li>Pensa ai tuoi obiettivi di carriera</li>
                    <li>Avere carta e penna per prendere note</li>
                </ul>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
                <p style="margin: 0; color: #666;">
                    Ti invierò il link per la video chiamata 24 ore prima dell'appuntamento.
                    <br>Se hai domande, rispondi pure a questa email!
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #2c3e50; color: white; padding: 20px; text-align: center;">
            <p style="margin: 0;">
                <strong>Valentin Procida</strong><br>
                VFX Artist & Career Consultant<br>
                <a href="https://www.valentinprocida.it" style="color: #74b9ff; text-decoration: none;">www.valentinprocida.it</a>
            </p>
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
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f5f5f5;">
    <div style="max-width: 600px; margin: 0 auto; background: white;">
        
        <!-- Header -->
        <div style="background: #1a73e8; color: white; padding: 30px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">🎥 Link Google Meet Pronto!</h1>
            <p style="margin: 10px 0 0 0; opacity: 0.9;">Il tuo appuntamento è tra 24 ore</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 30px;">
            
            <h2 style="color: #2c3e50; margin-bottom: 20px;">Ciao ${bookingData.customerName}!</h2>
            
            <p style="color: #555; line-height: 1.6; margin-bottom: 30px;">
                Il tuo appuntamento è confermato e il link per la video chiamata è pronto. Ci vediamo domani!
            </p>
            
            <!-- Google Meet Link -->
            <div style="background: #1a73e8; color: white; padding: 30px; text-align: center; border-radius: 8px; margin: 30px 0;">
                <h3 style="margin: 0 0 20px 0;">🔗 Link Google Meet</h3>
                <a href="${meetingInfo.meetLink}" 
                   style="background: white; color: #1a73e8; padding: 15px 30px; text-decoration: none; 
                          border-radius: 25px; font-weight: bold; font-size: 16px; display: inline-block;">
                    🎥 Unisciti alla Video Chiamata
                </a>
                <p style="margin: 20px 0 0 0; opacity: 0.9; font-size: 14px;">
                    Clicca sul link 5-10 minuti prima dell'appuntamento
                </p>
            </div>
            
            <!-- Meeting Details -->
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 30px 0;">
                <h3 style="color: #2c3e50; margin-top: 0;">📅 Dettagli Appuntamento</h3>
                <p style="margin: 10px 0;"><strong>Data:</strong> ${formattedDate}</p>
                <p style="margin: 10px 0;"><strong>Orario:</strong> ${startTime} - ${endTime}</p>
                <p style="margin: 10px 0;"><strong>Fuso Orario:</strong> Europe/Rome (GMT+1)</p>
                <p style="margin: 10px 0;"><strong>Durata:</strong> 90 minuti</p>
            </div>
            
            <!-- Instructions -->
            <div style="background: #fff3cd; padding: 20px; border-radius: 8px; margin: 30px 0;">
                <h3 style="color: #856404; margin-top: 0;">📋 Checklist Pre-Chiamata</h3>
                <ul style="color: #856404; line-height: 1.6;">
                    <li>Test audio e video 10 minuti prima</li>
                    <li>Connessione internet stabile</li>
                    <li>Ambiente tranquillo e buona illuminazione</li>
                    <li>Portfolio, domande e materiali pronti</li>
                </ul>
            </div>
            
            <!-- Calendar Button -->
            <div style="text-align: center; margin: 30px 0;">
                <a href="${meetingInfo.eventLink}" 
                   style="background: #28a745; color: white; padding: 12px 25px; text-decoration: none; 
                          border-radius: 25px; font-weight: bold; display: inline-block;">
                    📅 Visualizza nel Google Calendar
                </a>
                <p style="color: #666; margin: 15px 0 0 0; font-size: 14px;">
                    L'evento è stato automaticamente aggiunto al tuo calendario
                </p>
            </div>
            
            <!-- Support -->
            <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center;">
                <p style="margin: 0; color: #666; font-size: 14px;">
                    <strong>Problemi tecnici?</strong><br>
                    Contattami immediatamente a 
                    <a href="mailto:${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}" style="color: #1a73e8;">
                        ${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}
                    </a>
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #2c3e50; color: white; padding: 20px; text-align: center;">
            <p style="margin: 0;">
                <strong>Valentin Procida</strong><br>
                VFX Artist & Career Consultant<br>
                <a href="https://www.valentinprocida.it" style="color: #74b9ff; text-decoration: none;">www.valentinprocida.it</a>
            </p>
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
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); min-height: 100vh;">
    
    <div style="max-width: 600px; margin: 0 auto; background: white; box-shadow: 0 20px 60px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); padding: 50px 40px; text-align: center;">
            <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 30px; border: 1px solid rgba(255,255,255,0.2);">
                <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 300; letter-spacing: 1px;">🎉 Your Discount Code is Ready!</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px; font-weight: 300;">Exclusive ${discountAmount}% discount for VFX consultation</p>
            </div>
        </div>
        
        <!-- Content -->
        <div style="padding: 50px 40px;">
            
            <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 24px; font-weight: 400;">${name ? `Hi ${name}!` : 'Hello!'}</h2>
                <p style="color: #7f8c8d; font-size: 16px; line-height: 1.6; margin: 0;">
                    Thank you for your interest in my VFX consultation services! Here's your exclusive discount code:
                </p>
            </div>
            
            <!-- Discount Code Box -->
            <div style="background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%); border-radius: 20px; padding: 40px; text-align: center; margin: 30px 0; position: relative; overflow: hidden;">
                <div style="position: absolute; top: -30px; right: -30px; width: 80px; height: 80px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
                <div style="position: relative; z-index: 1;">
                    <p style="color: rgba(255,255,255,0.9); margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Your Discount Code</p>
                    <div style="background: white; color: #ff6b6b; padding: 20px; border-radius: 15px; margin: 20px 0; font-size: 32px; font-weight: bold; letter-spacing: 3px; word-break: break-all;">${discountCode}</div>
                    <p style="color: white; margin: 10px 0 0 0; font-size: 18px; font-weight: 600;">Save ${discountAmount}% on your VFX consultation</p>
                </div>
            </div>
            
            <!-- CTA Button -->
            <div style="text-align: center; margin: 40px 0;">
                <a href="https://www.valentinprocida.it/buy.html" 
                   style="background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%); color: white; padding: 20px 40px; text-decoration: none; 
                          border-radius: 50px; font-weight: 600; font-size: 18px; display: inline-block;
                          box-shadow: 0 10px 30px rgba(44, 62, 80, 0.3); letter-spacing: 1px;">
                    🚀 Book Your Consultation Now
                </a>
            </div>
            
            <!-- Instructions -->
            <div style="background: #f8f9fa; border-radius: 15px; padding: 30px; margin: 30px 0;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; text-align: center;">How to Use Your Code</h3>
                <div style="display: grid; gap: 15px;">
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <span style="background: #ff6b6b; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0;">1</span>
                        <span style="color: #2c3e50;">Visit the consultation booking page</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <span style="background: #ff6b6b; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0;">2</span>
                        <span style="color: #2c3e50;">Enter code <strong>${discountCode}</strong> at checkout</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 15px;">
                        <span style="background: #ff6b6b; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; flex-shrink: 0;">3</span>
                        <span style="color: #2c3e50;">Enjoy your ${discountAmount}% discount!</span>
                    </div>
                </div>
            </div>
            
            <div style="text-align: center; padding: 20px; background: #fff3cd; border-radius: 15px; border-left: 5px solid #ffc107;">
                <p style="color: #856404; margin: 0; font-size: 14px;">
                    ⏰ <strong>This code expires in 30 days.</strong><br>
                    Questions? Reply to this email and I'll help you out!
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%); color: white; padding: 40px; text-align: center;">
            <h3 style="margin: 0 0 10px 0; font-size: 20px; font-weight: 400;">Best regards,</h3>
            <p style="margin: 0 0 20px 0; color: rgba(255,255,255,0.8); font-size: 16px;">
                <strong>Valentin Procida</strong><br>
                VFX Artist & Rigger
            </p>
            <div style="display: flex; justify-content: center; gap: 20px;">
                <a href="https://www.linkedin.com/in/valentinprocida" style="color: rgba(255,255,255,0.9); text-decoration: none;">LinkedIn</a>
                <a href="https://vimeo.com/valentinprocida" style="color: rgba(255,255,255,0.9); text-decoration: none;">Vimeo</a>
                <a href="https://www.valentinprocida.it" style="color: rgba(255,255,255,0.9); text-decoration: none;">Website</a>
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
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f8f9fa;">
    <div style="max-width: 600px; margin: 0 auto; background: white; box-shadow: 0 10px 30px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); padding: 40px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 600;">🎯 Nuova Prenotazione Ricevuta</h1>
            <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Sistema di prenotazioni VFX</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 40px;">
            
            <!-- Customer Info -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; border-bottom: 2px solid #28a745; padding-bottom: 10px;">👤 Informazioni Cliente</h3>
                <div style="background: #f8f9fa; padding: 20px; border-radius: 10px;">
                    <p style="margin: 0 0 10px 0;"><strong>Nome:</strong> ${bookingData.customerName || bookingData.name}</p>
                    <p style="margin: 0 0 10px 0;"><strong>Email:</strong> <a href="mailto:${bookingData.customerEmail || bookingData.email}" style="color: #28a745;">${bookingData.customerEmail || bookingData.email}</a></p>
                    <p style="margin: 0 0 10px 0;"><strong>Telefono:</strong> <a href="tel:${bookingData.customerPhone || bookingData.phone}" style="color: #28a745;">${bookingData.customerPhone || bookingData.phone}</a></p>
                    ${bookingData.company ? `<p style="margin: 0;"><strong>Azienda:</strong> ${bookingData.company}</p>` : ''}
                </div>
            </div>
            
            <!-- Appointment Details -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; border-bottom: 2px solid #007bff; padding-bottom: 10px;">📅 Dettagli Appuntamento</h3>
                <div style="background: #e3f2fd; padding: 20px; border-radius: 10px;">
                    <p style="margin: 0 0 10px 0;"><strong>Data:</strong> ${formattedDate}</p>
                    <p style="margin: 0 0 10px 0;"><strong>Orario:</strong> ${bookingData.appointmentTime || 'Non specificato'}</p>
                    <p style="margin: 0;"><strong>Durata:</strong> 90 minuti</p>
                </div>
            </div>
            
            <!-- Payment Details -->
            <div style="margin-bottom: 30px;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; border-bottom: 2px solid #ffc107; padding-bottom: 10px;">💰 Dettagli Pagamento</h3>
                <div style="background: #fff3cd; padding: 20px; border-radius: 10px;">
                    <p style="margin: 0 0 10px 0;"><strong>Importo:</strong> €${finalAmount}</p>
                    ${bookingData.discount ? `<p style="margin: 0 0 10px 0;"><strong>Sconto:</strong> ${bookingData.discount.code} (-€${(bookingData.discount.discountAmount / 100).toFixed(2)})</p>` : ''}
                    <p style="margin: 0 0 10px 0;"><strong>ID Stripe:</strong> <code style="background: #f8f9fa; padding: 2px 6px; border-radius: 4px; font-size: 12px;">${bookingData.paymentIntent || bookingData.paymentId}</code></p>
                    <p style="margin: 0;"><strong>Data pagamento:</strong> ${new Date().toLocaleString('it-IT')}</p>
                </div>
            </div>
            
            <!-- Quick Actions -->
            <div style="text-align: center;">
                ${process.env.GOOGLE_SPREADSHEET_ID ? `
                <a href="https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SPREADSHEET_ID}" 
                   style="background: #28a745; color: white; padding: 12px 25px; text-decoration: none; 
                          border-radius: 25px; font-weight: 600; display: inline-block; margin: 5px;">
                    📊 Google Sheets
                </a>` : ''}
                <a href="mailto:${bookingData.customerEmail || bookingData.email}" 
                   style="background: #007bff; color: white; padding: 12px 25px; text-decoration: none; 
                          border-radius: 25px; font-weight: 600; display: inline-block; margin: 5px;">
                    📧 Rispondi Cliente
                </a>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: #2c3e50; color: white; padding: 20px; text-align: center;">
            <p style="margin: 0; font-size: 14px;">Sistema di Prenotazione VFX Consulting - Powered by Valentin Procida</p>
        </div>
    </div>
</body>
</html>`;
}

// ===== SCHEDULER & EMAIL FUNCTIONS =====
function scheduleReminderEmail(bookingData, meetingInfo) {
    console.log('📧 scheduleReminderEmail chiamata con:', {
        appointmentDate: bookingData.appointmentDate,
        appointmentTime: bookingData.appointmentTime,
        meetingInfo: meetingInfo ? 'PRESENTE' : 'MANCANTE'
    });

    if (!meetingInfo) {
        console.error('❌ meetingInfo è null - non posso programmare email Google Meet');
        return;
    }

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
app.use('/api/stripe-webhook', express.raw({type: 'application/json'}));
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
        env: process.env.NODE_ENV || 'development'
    });
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
            return res.status(200).json({received: true});
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
    
    res.json({received: true});
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
            'GET /api/test-sheets',
            'GET /api/test-calendar',
            'POST /api/test-google-meet-email',
            'POST /api/force-google-meet-email',
            'POST /api/send-discount-email',
            'POST /api/validate-discount',
            'POST /api/create-payment-intent',
            'POST /api/booking-confirmation',
            'GET /api/discount-stats',
            'POST /api/test-email'
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
            console.log(`🌐 Server ready at: http://localhost:${PORT}`);
            
            console.log('\n🎯 Codici sconto disponibili:');
            Object.entries(discountCodes).slice(0, 5).forEach(([code, data]) => {
                console.log(`- ${code}: ${data.description}`);
            });
            console.log(`... e altri ${Math.max(0, Object.keys(discountCodes).length - 5)} codici\n`);
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
