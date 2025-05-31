// server.js - Sistema completo con codici sconto automatici e email
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 10000;

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
    // Codici manuali strategici
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

// ===== TEMPLATE EMAIL =====
function createDiscountEmailTemplate(name, discountCode, discountAmount) {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Discount Code - Valentin Procida</title>
</head>
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f3ede6;">
    <div style="max-width: 600px; margin: 0 auto; background-color: white;">
        <!-- Header -->
        <div style="background-color: #0a0a0a; padding: 30px; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px; letter-spacing: 1px;">VALENTIN PROCIDA</h1>
            <p style="color: #ff4136; margin: 5px 0 0 0; font-size: 14px; letter-spacing: 1px;">RIGGER & CFX ARTIST</p>
        </div>
        
        <!-- Main Content -->
        <div style="padding: 40px 30px;">
            <h2 style="color: #0a0a0a; font-size: 28px; margin: 0 0 20px 0; text-align: center;">🎉 Your Discount Code is Ready!</h2>
            
            <p style="color: #666; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
                ${name ? `Hi ${name},` : 'Hello!'}<br><br>
                Thank you for your interest in my VFX consultation services! Here's your exclusive ${discountAmount}% discount code:
            </p>
            
            <!-- Discount Code Box -->
            <div style="background-color: #ff4136; color: white; padding: 25px; border-radius: 8px; text-align: center; margin: 30px 0;">
                <p style="margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Your Discount Code</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 3px; margin: 10px 0;">${discountCode}</div>
                <p style="margin: 10px 0 0 0; font-size: 14px;">Save ${discountAmount}% on your VFX consultation</p>
            </div>
            
            <!-- Features -->
            <div style="background-color: #f8f8f8; padding: 25px; border-radius: 8px; margin: 30px 0;">
                <h3 style="color: #0a0a0a; margin: 0 0 20px 0;">What's included in your consultation:</h3>
                <ul style="color: #666; line-height: 1.8; margin: 0; padding-left: 20px;">
                    <li>90-minute personalized 1-on-1 session</li>
                    <li>Portfolio analysis and feedback</li>
                    <li>Career roadmap tailored to your goals</li>
                    <li>Industry insights and networking tips</li>
                    <li>Custom CV and email templates</li>
                    <li>Follow-up resources and materials</li>
                </ul>
            </div>
            
            <!-- CTA Button -->
            <div style="text-align: center; margin: 40px 0;">
                <a href="https://www.valentinprocida.it/sales.html" 
                   style="background-color: #ff4136; color: white; padding: 15px 30px; text-decoration: none; 
                          border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;
                          text-transform: uppercase; letter-spacing: 1px;">
                    Book Your Consultation Now
                </a>
            </div>
            
            <div style="border-top: 1px solid #eee; padding-top: 20px; margin-top: 30px;">
                <p style="color: #999; font-size: 14px; line-height: 1.6;">
                    <strong>How to use your code:</strong><br>
                    1. Visit the consultation booking page<br>
                    2. Enter code <strong>${discountCode}</strong> at checkout<br>
                    3. Enjoy your ${discountAmount}% discount!
                </p>
                
                <p style="color: #999; font-size: 12px; margin-top: 20px;">
                    This code expires in 30 days. Can't find the checkout page? Reply to this email and I'll help you out!
                </p>
            </div>
        </div>
        
        <!-- Footer -->
        <div style="background-color: #0a0a0a; padding: 20px; text-align: center;">
            <p style="color: white; margin: 0; font-size: 14px;">
                Best regards,<br>
                <strong>Valentin Procida</strong><br>
                VFX Artist & Rigger
            </p>
            <div style="margin-top: 15px;">
                <a href="https://www.linkedin.com/in/valentinprocida" style="color: #ff4136; text-decoration: none; margin: 0 10px;">LinkedIn</a>
                <a href="https://vimeo.com/valentinprocida" style="color: #ff4136; text-decoration: none; margin: 0 10px;">Vimeo</a>
                <a href="https://www.valentinprocida.it" style="color: #ff4136; text-decoration: none; margin: 0 10px;">Website</a>
            </div>
        </div>
    </div>
</body>
</html>`;
}

// Funzione per estrarre nome dall'email
function extractNameFromEmail(email) {
    const localPart = email.split('@')[0];
    const cleanName = localPart.replace(/[0-9._-]/g, ' ').trim();
    return cleanName || null;
}

// ===== FUNZIONI HELPER =====
function generateInitialCodes() {
    console.log('🎫 Generazione automatica codici sconto...');
    
    // Genera 5 codici generali
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

    // Genera 3 codici social
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

    // Genera 4 codici speciali
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

// Invia codice sconto via email
app.post('/api/send-discount-email', async (req, res) => {
    try {
        const { email, name } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email richiesta' });
        }

        if (!transporter) {
            return res.status(500).json({ error: 'Servizio email non configurato' });
        }
        
        // Validazione email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Email non valida' });
        }
        
        // Genera un nuovo codice sconto automaticamente
        const newCode = codeGenerator.createDiscountCode({
            category: 'welcome',
            description: 'Email Signup Discount - Sconto 10%',
            maxUses: 1, // Uso singolo per email
            validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 giorni
        });
        
        // Aggiungi al database
        discountCodes[newCode.code] = {
            type: newCode.type,
            value: newCode.value,
            description: newCode.description,
            active: newCode.active,
            maxUses: newCode.maxUses,
            usedCount: newCode.usedCount,
            validUntil: newCode.validUntil,
            assignedTo: email, // Traccia a chi è assegnato
            createdAt: new Date()
        };
        
        // Estrai nome dall'email se non fornito
        const recipientName = name || extractNameFromEmail(email);
        
        // Configura email
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

Book now: https://www.valentinprocida.it/sales.html

Best regards,
Valentin Procida
VFX Artist & Rigger
            `
        };
        
        // Invia email
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

// Controlla se email già usata per discount
app.post('/api/check-email-discount', async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email richiesta' });
        }
        
        // Cerca codici già assegnati a questa email
        const existingCodes = Object.entries(discountCodes)
            .filter(([code, data]) => data.assignedTo === email)
            .map(([code, data]) => ({
                code,
                used: data.usedCount > 0,
                expired: data.validUntil && new Date() > data.validUntil
            }));
        
        const hasValidCode = existingCodes.some(c => !c.used && !c.expired);
        
        res.json({
            hasExistingCode: existingCodes.length > 0,
            hasValidCode: hasValidCode,
            codes: existingCodes
        });
        
    } catch (error) {
        console.error('Errore controllo email:', error);
        res.status(500).json({ error: 'Errore nel controllo email' });
    }
});

// Valida un codice sconto
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

// ===== ENDPOINTS GENERAZIONE CODICI =====

// Genera nuovo codice manualmente
app.post('/api/generate-discount-code', async (req, res) => {
    try {
        const { category, description, maxUses, validUntil, customCode } = req.body;
        
        const newCode = codeGenerator.createDiscountCode({
            category, description, maxUses: maxUses || 100,
            validUntil: validUntil ? new Date(validUntil) : null,
            customCode
        });

        discountCodes[newCode.code] = {
            type: newCode.type, value: newCode.value, description: newCode.description,
            active: newCode.active, maxUses: newCode.maxUses, usedCount: newCode.usedCount,
            validUntil: newCode.validUntil
        };

        console.log(`✅ Nuovo codice generato: ${newCode.code}`);
        res.json({ success: true, code: newCode.code, details: newCode });
    } catch (error) {
        console.error('Errore generazione codice:', error);
        res.status(500).json({ error: 'Errore nella generazione del codice sconto' });
    }
});

// Genera campagna di codici
app.post('/api/generate-campaign', async (req, res) => {
    try {
        const { campaignName, categories, codesPerCategory, maxUses, validUntil } = req.body;
        
        const campaignCodes = [];
        const categoriesToUse = categories || ['general'];
        const codesPerCat = codesPerCategory || 3;

        categoriesToUse.forEach(category => {
            for (let i = 0; i < codesPerCat; i++) {
                const newCode = codeGenerator.createDiscountCode({
                    category,
                    description: `${campaignName} - ${category} - Sconto 10%`,
                    maxUses: maxUses || 50,
                    validUntil: validUntil ? new Date(validUntil) : null
                });

                discountCodes[newCode.code] = {
                    type: newCode.type, value: newCode.value, description: newCode.description,
                    active: newCode.active, maxUses: newCode.maxUses, usedCount: newCode.usedCount,
                    validUntil: newCode.validUntil
                };

                campaignCodes.push({ code: newCode.code, category, description: newCode.description });
            }
        });

        console.log(`🚀 Campagna "${campaignName}" creata con ${campaignCodes.length} codici`);
        res.json({ success: true, campaign: campaignName, codes: campaignCodes });
    } catch (error) {
        console.error('Errore generazione campagna:', error);
        res.status(500).json({ error: 'Errore nella generazione della campagna' });
    }
});

// ===== ENDPOINTS STRIPE =====

// Crea Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { email, name, phone, discountCode } = req.body;
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
                email, name, phone: phone || '', product: 'vfx-consultation', productId: 'cons-001',
                originalAmount: originalAmount.toString(), discountCode: discountCode || '',
                discountAmount: discountInfo ? discountInfo.discountAmount.toString() : '0',
                finalAmount: finalAmount.toString()
            },
            description: 'VFX Career Consultation with Valentin Procida'
        });
        
        if (discountCode && discountInfo) {
            const discount = discountCodes[discountCode.toUpperCase()];
            if (discount) {
                discount.usedCount++;
                console.log(`Codice ${discountCode} utilizzato. Nuovo conteggio: ${discount.usedCount}`);
            }
        }
        
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

// Verifica pagamento
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { paymentIntentId } = req.body;
        if (!paymentIntentId) return res.status(400).json({ error: 'Payment Intent ID richiesto' });
        
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status === 'succeeded') {
            res.json({
                success: true, email: paymentIntent.metadata.email, name: paymentIntent.metadata.name,
                amount: paymentIntent.amount, currency: paymentIntent.currency, paymentId: paymentIntent.id,
                discountCode: paymentIntent.metadata.discountCode || null,
                discountAmount: paymentIntent.metadata.discountAmount || '0',
                originalAmount: paymentIntent.metadata.originalAmount || paymentIntent.amount.toString(),
                receipt_url: paymentIntent.charges.data[0]?.receipt_url
            });
        } else {
            res.json({ success: false, status: paymentIntent.status, paymentId: paymentIntent.id });
        }
    } catch (error) {
        console.error('Errore verifica pagamento:', error);
        res.status(500).json({ error: 'Errore nella verifica del pagamento', details: error.message });
    }
});

// ===== ENDPOINTS GESTIONE CODICI =====

// Statistiche codici sconto
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

// Modifica codice sconto
app.patch('/api/discount-code/:code', (req, res) => {
    try {
        const { code } = req.params;
        const { active, maxUses, validUntil } = req.body;
        
        const upperCode = code.toUpperCase();
        if (!discountCodes[upperCode]) {
            return res.status(404).json({ error: 'Codice non trovato' });
        }
        
        if (typeof active === 'boolean') {
            discountCodes[upperCode].active = active;
        }
        
        if (maxUses !== undefined) {
            discountCodes[upperCode].maxUses = maxUses;
        }
        
        if (validUntil) {
            discountCodes[upperCode].validUntil = new Date(validUntil);
        }
        
        console.log(`🔄 Codice ${upperCode} aggiornato`);
        res.json({ 
            success: true, 
            code: upperCode, 
            updated: discountCodes[upperCode] 
        });
    } catch (error) {
        console.error('Errore aggiornamento codice:', error);
        res.status(500).json({ error: 'Errore nell\'aggiornamento del codice' });
    }
});

// Elimina codice sconto
app.delete('/api/discount-code/:code', (req, res) => {
    try {
        const { code } = req.params;
        const upperCode = code.toUpperCase();
        
        if (!discountCodes[upperCode]) {
            return res.status(404).json({ error: 'Codice non trovato' });
        }
        
        delete discountCodes[upperCode];
        console.log(`🗑️ Codice ${upperCode} eliminato`);
        res.json({ success: true, message: `Codice ${upperCode} eliminato` });
    } catch (error) {
        console.error('Errore eliminazione codice:', error);
        res.status(500).json({ error: 'Errore nell\'eliminazione del codice' });
    }
});

// Categorie disponibili
app.get('/api/discount-categories', (req, res) => {
    res.json({
        categories: Object.keys(codeGenerator.prefixes),
        descriptions: {
            general: 'Codici generali per tutti',
            seasonal: 'Codici stagionali',
            target: 'Codici per gruppi specifici',
            social: 'Codici per social media',
            events: 'Codici per eventi',
            special: 'Offerte speciali',
            welcome: 'Codici di benvenuto'
        }
    });
});

// Cleanup codici scaduti
app.post('/api/cleanup-expired-codes', (req, res) => {
    try {
        let deactivatedCount = 0;
        const now = new Date();
        
        Object.entries(discountCodes).forEach(([code, data]) => {
            if (data.validUntil && now > data.validUntil && data.active) {
                data.active = false;
                deactivatedCount++;
            }
        });
        
        console.log(`🧹 Cleanup completato: ${deactivatedCount} codici scaduti disattivati`);
        res.json({ 
            success: true, 
            deactivatedCount,
            message: `${deactivatedCount} codici scaduti disattivati` 
        });
    } catch (error) {
        console.error('Errore cleanup:', error);
        res.status(500).json({ error: 'Errore nel cleanup dei codici' });
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
                discountCode: paymentIntent.metadata.discountCode || 'Nessuno',
                discountAmount: paymentIntent.metadata.discountAmount || '0',
                originalAmount: paymentIntent.metadata.originalAmount || paymentIntent.amount
            });
            
            if (paymentIntent.metadata.discountCode) {
                const savings = parseInt(paymentIntent.metadata.discountAmount) / 100;
                console.log(`🎉 Cliente ha risparmiato €${savings.toFixed(2)} con il codice ${paymentIntent.metadata.discountCode}`);
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
            
        case 'payment_method.attached':
            console.log('💳 Metodo di pagamento allegato');
            break;
            
        default:
            console.log(`Evento non gestito: ${event.type}`);
    }
    
    res.json({received: true});
});

// ===== ENDPOINT TEST EMAIL =====
app.post('/api/test-email', async (req, res) => {
    try {
        if (!transporter) {
            return res.status(500).json({ error: 'Servizio email non configurato' });
        }
        
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: 'Email richiesta per il test' });
        }
        
        const testMailOptions = {
            from: {
                name: 'Valentin Procida',
                address: process.env.EMAIL_USER
            },
            to: email,
            subject: 'Test Email Configuration',
            html: `
                <h2>Email Test Successful!</h2>
                <p>If you're reading this, your email configuration is working correctly.</p>
                <p>Server time: ${new Date().toISOString()}</p>
            `,
            text: `Email Test Successful! Server time: ${new Date().toISOString()}`
        };
        
        await transporter.sendMail(testMailOptions);
        console.log(`📧 Email di test inviata a ${email}`);
        
        res.json({ success: true, message: 'Test email sent successfully' });
        
    } catch (error) {
        console.error('Errore test email:', error);
        res.status(500).json({ error: 'Errore nel test email', details: error.message });
    }
});

// ===== CATCH-ALL E ERROR HANDLING =====
app.use(/^\/api\/.*/, (req, res) => {
    res.status(404).json({ 
        error: 'API endpoint not found',
        path: req.path,
        availableEndpoints: [
            'GET /api/health',
            'GET /api/config', 
            'POST /api/send-discount-email',
            'POST /api/check-email-discount',
            'POST /api/validate-discount',
            'POST /api/create-payment-intent',
            'POST /api/verify-payment',
            'GET /api/discount-stats',
            'POST /api/generate-discount-code',
            'POST /api/generate-campaign',
            'PATCH /api/discount-code/:code',
            'DELETE /api/discount-code/:code',
            'GET /api/discount-categories',
            'POST /api/cleanup-expired-codes',
            'POST /api/test-email'
        ]
    });
});

// ===== INIZIALIZZAZIONE =====
generateInitialCodes();

// Cleanup automatico ogni ora
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

// Test configurazione email all'avvio
if (transporter) {
    transporter.verify((error, success) => {
        if (error) {
            console.error('❌ Errore configurazione email:', error.message);
        } else {
            console.log('📧 Server email configurato correttamente');
        }
    });
}

// ===== AVVIO SERVER =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
    console.log(`🔑 Stripe publishable key configured: ${!!process.env.STRIPE_PUBLISHABLE_KEY}`);
    console.log(`🪝 Webhook secret configured: ${!!process.env.STRIPE_WEBHOOK_SECRET}`);
    console.log(`📧 Email configured: ${!!transporter}`);
    console.log(`🎫 Codici sconto disponibili: ${Object.keys(discountCodes).length}`);
    console.log(`🤖 Generatore automatico attivo`);
    console.log(`🌐 Server ready at: http://localhost:${PORT}`);
    
    // Mostra alcuni codici di esempio
    console.log('\n🎯 Codici sconto disponibili:');
    Object.entries(discountCodes).slice(0, 5).forEach(([code, data]) => {
        console.log(`- ${code}: ${data.description}`);
    });
    console.log(`... e altri ${Math.max(0, Object.keys(discountCodes).length - 5)} codici\n`);
});

// ===== GESTIONE ERRORI =====
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
