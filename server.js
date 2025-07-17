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
    if (!calendar || !process.env.GOOGLE_CALENDAR_ID) {
        console.warn('⚠️ Google Calendar non configurato - saltando creazione evento');
        return null;
    }

    try {
        const appointmentDate = new Date(bookingData.appointmentDate);
        const [hours, minutes] = bookingData.appointmentTime.split(':');
        
        const startTime = new Date(appointmentDate);
        startTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        
        const endTime = new Date(startTime);
        endTime.setMinutes(endTime.getMinutes() + 90);

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
            `.trim(),
            start: {
                dateTime: startTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            end: {
                dateTime: endTime.toISOString(),
                timeZone: 'Europe/Rome',
            },
            attendees: [
                { email: bookingData.customerEmail, displayName: bookingData.customerName },
                { email: process.env.ADMIN_EMAIL || process.env.EMAIL_USER }
            ],
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

        const createdEvent = await calendar.events.insert({
            calendarId: process.env.GOOGLE_CALENDAR_ID,
            resource: event,
            conferenceDataVersion: 1,
            sendUpdates: 'all'
        });

        console.log('✅ Evento Google Calendar creato:', createdEvent.data.id);
        console.log('🔗 Google Meet Link:', createdEvent.data.hangoutLink);

        return {
            eventId: createdEvent.data.id,
            meetLink: createdEvent.data.hangoutLink,
            eventLink: createdEvent.data.htmlLink,
            startTime: startTime,
            endTime: endTime
        };

    } catch (error) {
        console.error('❌ Errore creazione evento Google Calendar:', error.message);
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
    <title>Booking Confirmation - Valentin Procida</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh;">
    
    <!-- Main Container -->
    <div style="max-width: 650px; margin: 0 auto; background: white; box-shadow: 0 20px 60px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 50px 40px; text-align: center; position: relative;">
            <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 30px; border: 1px solid rgba(255,255,255,0.2);">
                <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 300; letter-spacing: 1px;">✅ Prenotazione Confermata</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px; font-weight: 300;">La tua consulenza VFX è stata confermata con successo</p>
            </div>
        </div>
        
        <!-- Content -->
        <div style="padding: 50px 40px;">
            
            <!-- Welcome Message -->
            <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 24px; font-weight: 400;">Ciao ${bookingData.customerName || bookingData.name}!</h2>
                <p style="color: #7f8c8d; font-size: 16px; line-height: 1.6; margin: 0;">
                    La tua consulenza VFX personalizzata è stata confermata. Riceverai il link Google Meet 24 ore prima dell'appuntamento.
                </p>
            </div>
            
            <!-- Appointment Card -->
            <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); border-radius: 20px; padding: 30px; margin: 30px 0; border-left: 5px solid #667eea; position: relative; overflow: hidden;">
                <div style="position: absolute; top: -50px; right: -50px; width: 100px; height: 100px; background: rgba(102, 126, 234, 0.1); border-radius: 50%;"></div>
                <div style="position: relative; z-index: 1;">
                    <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                        <span style="background: #667eea; width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 12px;"></span>
                        Dettagli Appuntamento
                    </h3>
                    <div style="display: grid; gap: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                            <span style="color: #6c757d; font-weight: 500;">📅 Data</span>
                            <span style="color: #2c3e50; font-weight: 600;">${formattedDate}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                            <span style="color: #6c757d; font-weight: 500;">⏰ Orario</span>
                            <span style="color: #2c3e50; font-weight: 600;">${bookingData.appointmentTime || 'Da confermare'}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                            <span style="color: #6c757d; font-weight: 500;">⏱️ Durata</span>
                            <span style="color: #2c3e50; font-weight: 600;">90 minuti</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0;">
                            <span style="color: #6c757d; font-weight: 500;">🎥 Modalità</span>
                            <span style="color: #2c3e50; font-weight: 600;">Video chiamata Google Meet</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Payment Summary -->
            <div style="background: white; border: 1px solid #e9ecef; border-radius: 20px; padding: 30px; margin: 30px 0; box-shadow: 0 5px 15px rgba(0,0,0,0.05);">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                    <span style="background: #28a745; width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 12px;"></span>
                    Riepilogo Pagamento
                </h3>
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 20px 0; border-bottom: 1px solid #e9ecef;">
                    <span style="color: #6c757d; font-weight: 500;">💳 Importo pagato</span>
                    <span style="color: #28a745; font-weight: 700; font-size: 18px;">€${finalAmount}</span>
                </div>
                ${bookingData.discount ? `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                    <span style="color: #6c757d; font-weight: 500;">🎟️ Sconto applicato</span>
                    <span style="color: #667eea; font-weight: 600;">${bookingData.discount.code}</span>
                </div>` : ''}
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0;">
                    <span style="color: #6c757d; font-weight: 500;">🔐 ID Transazione</span>
                    <span style="color: #6c757d; font-family: monospace; font-size: 12px;">${bookingData.paymentIntent || bookingData.paymentId}</span>
                </div>
            </div>
            
            <!-- What to Expect -->
            <div style="background: linear-gradient(135deg, #e8f4f8 0%, #d1ecf1 100%); border-radius: 20px; padding: 30px; margin: 30px 0; border-left: 5px solid #17a2b8;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                    <span style="background: #17a2b8; width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 12px;"></span>
                    Cosa Aspettarsi dalla Consulenza
                </h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px;">
                    <div style="display: flex; align-items: flex-start; gap: 12px;">
                        <span style="background: #17a2b8; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;">📊</span>
                        <div>
                            <strong style="color: #2c3e50; display: block; margin-bottom: 5px;">Analisi Portfolio</strong>
                            <span style="color: #6c757d; font-size: 14px;">Review completa del tuo reel e portfolio VFX</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 12px;">
                        <span style="background: #17a2b8; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;">🗺️</span>
                        <div>
                            <strong style="color: #2c3e50; display: block; margin-bottom: 5px;">Roadmap Carriera</strong>
                            <span style="color: #6c757d; font-size: 14px;">Piano personalizzato per i tuoi obiettivi</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 12px;">
                        <span style="background: #17a2b8; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;">🎯</span>
                        <div>
                            <strong style="color: #2c3e50; display: block; margin-bottom: 5px;">Strategie Concrete</strong>
                            <span style="color: #6c757d; font-size: 14px;">Tattiche pratiche per entrare nell'industria</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 12px;">
                        <span style="background: #17a2b8; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;">📝</span>
                        <div>
                            <strong style="color: #2c3e50; display: block; margin-bottom: 5px;">CV & Email Templates</strong>
                            <span style="color: #6c757d; font-size: 14px;">Template ottimizzati per l'industria VFX</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 12px;">
                        <span style="background: #17a2b8; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;">🤝</span>
                        <div>
                            <strong style="color: #2c3e50; display: block; margin-bottom: 5px;">Network & Contatti</strong>
                            <span style="color: #6c757d; font-size: 14px;">Connessioni e opportunità nell'industria</span>
                        </div>
                    </div>
                    <div style="display: flex; align-items: flex-start; gap: 12px;">
                        <span style="background: #17a2b8; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;">📚</span>
                        <div>
                            <strong style="color: #2c3e50; display: block; margin-bottom: 5px;">Risorse Follow-up</strong>
                            <span style="color: #6c757d; font-size: 14px;">Materiali e guide per continuare il percorso</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Preparation Tips -->
            <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffeaa7 100%); border-radius: 20px; padding: 30px; margin: 30px 0; border-left: 5px solid #ffc107;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                    <span style="background: #ffc107; width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 12px;"></span>
                    Come Prepararsi alla Sessione
                </h3>
                <p style="color: #856404; margin-bottom: 20px; font-size: 16px;">Per massimizzare il valore della nostra consulenza:</p>
                <div style="display: grid; gap: 15px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">1</span>
                        <span style="color: #856404; font-weight: 500;">Prepara il tuo portfolio/reel più recente</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">2</span>
                        <span style="color: #856404; font-weight: 500;">Scrivi una lista delle tue domande specifiche</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">3</span>
                        <span style="color: #856404; font-weight: 500;">Rifletti sui tuoi obiettivi di carriera a breve e lungo termine</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">4</span>
                        <span style="color: #856404; font-weight: 500;">Tieni carta e penna pronti per prendere note</span>
                    </div>
                </div>
            </div>
            
            <!-- Next Steps -->
            <div style="text-align: center; margin: 40px 0; padding: 30px; background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); border-radius: 20px;">
                <h3 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">📧 Prossimi Passi</h3>
                <p style="color: #6c757d; margin: 0; font-size: 16px; line-height: 1.6;">
                    Ti invierò il <strong>link Google Meet</strong> 24 ore prima dell'appuntamento.<br>
                    Se hai domande urgenti, rispondi pure a questa email!
                </p>
            </div>
            
            <!-- Guarantee -->
            <div style="background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%); border-radius: 20px; padding: 30px; text-align: center; margin: 30px 0; border-left: 5px solid #28a745;">
                <div style="background: white; border-radius: 50%; width: 60px; height: 60px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
                    <span style="font-size: 24px;">🛡️</span>
                </div>
                <h3 style="color: #155724; margin: 0 0 10px 0; font-size: 20px; font-weight: 600;">Garanzia 100% Soddisfazione</h3>
                <p style="color: #155724; margin: 0; font-size: 16px;">
                    Se non sei completamente soddisfatto della consulenza, ti rimborserò entro 48 ore. La tua soddisfazione è la mia priorità.
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%); color: white; padding: 40px; text-align: center;">
            <div style="margin-bottom: 20px;">
                <h3 style="margin: 0 0 10px 0; font-size: 20px; font-weight: 400;">Valentin Procida</h3>
                <p style="margin: 0; color: rgba(255,255,255,0.8); font-size: 14px;">VFX Artist & Career Consultant</p>
            </div>
            <div style="display: flex; justify-content: center; gap: 20px; margin: 20px 0;">
                <a href="https://www.linkedin.com/in/valentinprocida" style="color: rgba(255,255,255,0.9); text-decoration: none; font-size: 14px;">LinkedIn</a>
                <a href="https://vimeo.com/valentinprocida" style="color: rgba(255,255,255,0.9); text-decoration: none; font-size: 14px;">Vimeo</a>
                <a href="https://www.valentinprocida.it" style="color: rgba(255,255,255,0.9); text-decoration: none; font-size: 14px;">Website</a>
            </div>
            <p style="margin: 20px 0 0 0; color: rgba(255,255,255,0.6); font-size: 12px;">
                © 2025 Valentin Procida - VFX Consulting. Tutti i diritti riservati.
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
    <title>Google Meet Link - Valentin Procida</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #1a73e8 0%, #4285f4 100%); min-height: 100vh;">
    
    <!-- Main Container -->
    <div style="max-width: 650px; margin: 0 auto; background: white; box-shadow: 0 20px 60px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #1a73e8 0%, #4285f4 100%); padding: 50px 40px; text-align: center; position: relative;">
            <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 20px; padding: 30px; border: 1px solid rgba(255,255,255,0.2);">
                <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 300; letter-spacing: 1px;">🎥 Link Video Chiamata Pronto!</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 16px; font-weight: 300;">Il tuo appuntamento VFX è tra 24 ore</p>
            </div>
        </div>
        
        <!-- Content -->
        <div style="padding: 50px 40px;">
            
            <!-- Welcome Message -->
            <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #2c3e50; margin: 0 0 15px 0; font-size: 24px; font-weight: 400;">Ciao ${bookingData.customerName}!</h2>
                <p style="color: #7f8c8d; font-size: 16px; line-height: 1.6; margin: 0;">
                    Il tuo appuntamento è confermato e il link per la video chiamata è pronto. Ci vediamo domani!
                </p>
            </div>
            
            <!-- Google Meet Link -->
            <div style="background: linear-gradient(135deg, #1a73e8 0%, #4285f4 100%); border-radius: 20px; padding: 40px; text-align: center; margin: 30px 0; position: relative; overflow: hidden;">
                <div style="position: absolute; top: -30px; right: -30px; width: 80px; height: 80px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
                <div style="position: absolute; bottom: -40px; left: -40px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
                <div style="position: relative; z-index: 1;">
                    <div style="background: white; border-radius: 50%; width: 60px; height: 60px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 5px 15px rgba(0,0,0,0.2);">
                        <span style="font-size: 24px;">🔗</span>
                    </div>
                    <h3 style="color: white; margin: 0 0 20px 0; font-size: 20px; font-weight: 600;">Link Google Meet</h3>
                    <a href="${meetingInfo.meetLink}" 
                       style="background: white; color: #1a73e8; padding: 15px 30px; text-decoration: none; 
                              border-radius: 50px; font-weight: 600; font-size: 16px; display: inline-block;
                              box-shadow: 0 5px 15px rgba(0,0,0,0.2); transition: all 0.3s ease;">
                        🎥 Unisciti alla Video Chiamata
                    </a>
                    <p style="color: rgba(255,255,255,0.9); margin: 20px 0 0 0; font-size: 14px;">
                        Clicca sul link 5-10 minuti prima dell'appuntamento
                    </p>
                </div>
            </div>
            
            <!-- Meeting Details -->
            <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); border-radius: 20px; padding: 30px; margin: 30px 0; border-left: 5px solid #1a73e8;">
                <h3 style="color: #2c3e50; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                    <span style="background: #1a73e8; width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 12px;"></span>
                    Dettagli Appuntamento
                </h3>
                <div style="display: grid; gap: 15px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                        <span style="color: #6c757d; font-weight: 500;">📅 Data</span>
                        <span style="color: #2c3e50; font-weight: 600;">${formattedDate}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                        <span style="color: #6c757d; font-weight: 500;">⏰ Orario</span>
                        <span style="color: #2c3e50; font-weight: 600;">${startTime} - ${endTime}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid #e9ecef;">
                        <span style="color: #6c757d; font-weight: 500;">🌍 Fuso Orario</span>
                        <span style="color: #2c3e50; font-weight: 600;">Europe/Rome (GMT+1)</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 0;">
                        <span style="color: #6c757d; font-weight: 500;">⏱️ Durata</span>
                        <span style="color: #2c3e50; font-weight: 600;">90 minuti</span>
                    </div>
                </div>
            </div>
            
            <!-- Instructions -->
            <div style="background: linear-gradient(135deg, #fff3cd 0%, #ffeaa7 100%); border-radius: 20px; padding: 30px; margin: 30px 0; border-left: 5px solid #ffc107;">
                <h3 style="color: #856404; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                    <span style="background: #ffc107; width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 12px;"></span>
                    Checklist Pre-Chiamata
                </h3>
                <div style="display: grid; gap: 15px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">✓</span>
                        <span style="color: #856404; font-weight: 500;">Test audio e video 10 minuti prima</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">✓</span>
                        <span style="color: #856404; font-weight: 500;">Connessione internet stabile</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">✓</span>
                        <span style="color: #856404; font-weight: 500;">Ambiente tranquillo e buona illuminazione</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="background: #ffc107; color: white; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0;">✓</span>
                        <span style="color: #856404; font-weight: 500;">Portfolio, domande e materiali pronti</span>
                    </div>
                </div>
            </div>
            
            <!-- Calendar Button -->
            <div style="text-align: center; margin: 40px 0;">
                <a href="${meetingInfo.eventLink}" 
                   style="background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; padding: 15px 30px; text-decoration: none; 
                          border-radius: 50px; font-weight: 600; font-size: 16px; display: inline-block;
                          box-shadow: 0 5px 15px rgba(40, 167, 69, 0.3);">
                    📅 Visualizza nel Google Calendar
                </a>
                <p style="color: #6c757d; margin: 15px 0 0 0; font-size: 14px;">
                    L'evento è stato automaticamente aggiunto al tuo calendario con promemoria
                </p>
            </div>
            
            <!-- Support -->
            <div style="background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 15px; padding: 25px; text-align: center; margin: 30px 0;">
                <h4 style="color: #2c3e50; margin: 0 0 10px 0; font-size: 16px;">❓ Problemi Tecnici?</h4>
                <p style="color: #6c757d; margin: 0; font-size: 14px;">
                    Se hai difficoltà con il link Google Meet, contattami immediatamente a<br>
                    <a href="mailto:${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}" 
                       style="color: #1a73e8; text-decoration: none; font-weight: 600;">
                        ${process.env.ADMIN_EMAIL || process.env.EMAIL_USER}
                    </a>
                </p>
            </div>
            
        </div>
        
        <!-- Footer -->
        <div style="background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%); color: white; padding: 40px; text-align: center;">
            <h3 style="margin: 0 0 10px 0; font-size: 20px; font-weight: 400;">A presto!</h3>
            <p style="margin: 0 0 20px 0; color: rgba(255,255,255,0.8); font-size: 16px;">
                <strong>Valentin Procida</strong><br>
                VFX Artist & Career Consultant
            </p>
            <div style="display: flex; justify-content: center; gap: 20px;">
                <a href="https://www.linkedin.com/in/valentinprocida" style="color: rgba(255,255,255,0.9); text-decoration: none;">LinkedIn</a>
                <a href="https://www.valentinprocida.it" style="color: rgba(255,255,255,0.9); text-decoration: none;">Website</a>
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
    const appointmentDate = new Date(bookingData.appointmentDate);
    const [hours, minutes] = bookingData.appointmentTime.split(':');
    
    const meetingTime = new Date(appointmentDate);
    meetingTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    const reminderTime = new Date(meetingTime.getTime() - 24 * 60 * 60 * 1000);
    const now = new Date();
    
    if (reminderTime <= now) {
        console.log('📧 Reminder time in passato, invio immediato');
        sendMeetingLinkEmail(bookingData, meetingInfo);
        return;
    }
    
    const timeUntilReminder = reminderTime.getTime() - now.getTime();
    
    console.log(`⏰ Email Google Meet programmata per: ${reminderTime.toLocaleString('it-IT')}`);
    
    setTimeout(() => {
        sendMeetingLinkEmail(bookingData, meetingInfo);
    }, timeUntilReminder);
}

async function sendMeetingLinkEmail(bookingData, meetingInfo) {
    if (!transporter) return;
    
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
        
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email Google Meet inviata a ${bookingData.customerEmail}`);
        
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
            'POST /api/send-discount-email',
            'POST /api/validate-discount',
            'POST /api/create-payment-intent',
            'POST /api/booking-confirmation',
            'GET /api/discount-stats'
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
