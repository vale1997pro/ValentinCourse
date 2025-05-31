// server.js
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Database dei codici sconto (in produzione usa un vero database)
const discountCodes = {
    'WELCOME10': {
        type: 'percentage',
        value: 10,
        description: 'Sconto 10%',
        active: true,
        maxUses: null,
        usedCount: 0,
        validUntil: null
    },
    'FIRST50': {
        type: 'fixed',
        value: 5000, // €50 in centesimi
        description: 'Sconto €50',
        active: true,
        maxUses: 100,
        usedCount: 25,
        validUntil: new Date('2025-12-31')
    },
    'VFX20': {
        type: 'percentage',
        value: 20,
        description: 'Sconto 20% VFX',
        active: true,
        maxUses: 50,
        usedCount: 10,
        validUntil: new Date('2025-07-31')
    },
    'EARLY30': {
        type: 'percentage',
        value: 30,
        description: 'Sconto Early Bird 30%',
        active: true,
        maxUses: 20,
        usedCount: 5,
        validUntil: new Date('2025-06-30')
    },
    'STUDENT15': {
        type: 'percentage',
        value: 15,
        description: 'Sconto Studenti 15%',
        active: true,
        maxUses: null,
        usedCount: 0,
        validUntil: null
    }
};

// Funzione per calcolare il prezzo scontato
function calculateDiscountedPrice(originalPrice, discountCode) {
    const discount = discountCodes[discountCode.toUpperCase()];
    
    if (!discount || !discount.active) {
        return { valid: false, error: 'Codice sconto non valido' };
    }
    
    // Verifica scadenza
    if (discount.validUntil && new Date() > discount.validUntil) {
        return { valid: false, error: 'Codice sconto scaduto' };
    }
    
    // Verifica numero massimo di utilizzi
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
    
    // Assicurati che il prezzo finale non sia negativo
    finalPrice = Math.max(finalPrice, 0);
    
    return {
        valid: true,
        originalPrice: originalPrice,
        discountAmount: discountAmount,
        finalPrice: finalPrice,
        discountCode: discountCode.toUpperCase(),
        discountDescription: discount.description,
        discountType: discount.type,
        discountValue: discount.value
    };
}

// Middleware per JSON (tranne per webhook)
app.use('/api/stripe-webhook', express.raw({type: 'application/json'}));
app.use(express.json());

// CORS configuration
app.use(cors({
    origin: [
        process.env.FRONTEND_URL || 'http://localhost:8000',
        'https://www.valentinprocida.it',
        'http://localhost:3000', // Per sviluppo locale
        'http://127.0.0.1:8000'
    ],
    credentials: true
}));

// Test endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'Server is running!', 
        timestamp: new Date(),
        env: process.env.NODE_ENV || 'development'
    });
});

// Endpoint per ottenere la chiave pubblica
app.get('/api/config', (req, res) => {
    console.log('Config requested');
    
    if (!process.env.STRIPE_PUBLISHABLE_KEY) {
        return res.status(500).json({ 
            error: 'Stripe publishable key not configured' 
        });
    }
    
    res.json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Endpoint per validare un codice sconto
app.post('/api/validate-discount', async (req, res) => {
    try {
        const { code, amount } = req.body;
        
        if (!code) {
            return res.status(400).json({ 
                error: 'Codice sconto richiesto' 
            });
        }
        
        const originalAmount = amount || 15000; // €150 di default
        const result = calculateDiscountedPrice(originalAmount, code);
        
        if (!result.valid) {
            return res.status(400).json({ 
                error: result.error 
            });
        }
        
        console.log('Codice sconto validato:', code, result);
        
        res.json({
            valid: true,
            originalPrice: result.originalPrice,
            discountAmount: result.discountAmount,
            finalPrice: result.finalPrice,
            discountCode: result.discountCode,
            description: result.discountDescription,
            savings: `€${(result.discountAmount / 100).toFixed(2)}`
        });
        
    } catch (error) {
        console.error('Errore validazione codice sconto:', error);
        res.status(500).json({ 
            error: 'Errore nella validazione del codice sconto' 
        });
    }
});

// Endpoint per creare un Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        console.log('Creating payment intent for:', req.body);
        
        const { email, name, phone, discountCode } = req.body;
        
        // Validazione
        if (!email || !name) {
            return res.status(400).json({ 
                error: 'Email e nome sono richiesti' 
            });
        }
        
        // Controlla che Stripe sia configurato
        if (!process.env.STRIPE_SECRET_KEY) {
            throw new Error('Stripe secret key not configured');
        }
        
        let originalAmount = 15000; // €150 in centesimi
        let finalAmount = originalAmount;
        let discountInfo = null;
        
        // Applica il codice sconto se presente
        if (discountCode) {
            const discountResult = calculateDiscountedPrice(originalAmount, discountCode);
            
            if (!discountResult.valid) {
                return res.status(400).json({ 
                    error: discountResult.error 
                });
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
        
        // Crea il Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: finalAmount,
            currency: 'eur',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                email: email,
                name: name,
                phone: phone || '',
                product: 'vfx-consultation',
                productId: 'cons-001',
                originalAmount: originalAmount.toString(),
                discountCode: discountCode || '',
                discountAmount: discountInfo ? discountInfo.discountAmount.toString() : '0',
                finalAmount: finalAmount.toString()
            },
            description: 'VFX Career Consultation with Valentin Procida'
        });
        
        console.log('Payment Intent creato:', paymentIntent.id, 'Amount:', finalAmount);
        
        // Se c'è un codice sconto valido, incrementa il contatore di utilizzi
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
            discountInfo: discountInfo
        });
        
    } catch (error) {
        console.error('Errore creazione payment intent:', error);
        res.status(500).json({ 
            error: 'Errore nel processare il pagamento',
            details: error.message 
        });
    }
});

// Endpoint per verificare il pagamento
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { paymentIntentId } = req.body;
        
        if (!paymentIntentId) {
            return res.status(400).json({ 
                error: 'Payment Intent ID richiesto' 
            });
        }
        
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status === 'succeeded') {
            console.log('Pagamento verificato per:', paymentIntent.metadata.email);
            
            res.json({
                success: true,
                email: paymentIntent.metadata.email,
                name: paymentIntent.metadata.name,
                amount: paymentIntent.amount,
                currency: paymentIntent.currency,
                paymentId: paymentIntent.id,
                discountCode: paymentIntent.metadata.discountCode || null,
                discountAmount: paymentIntent.metadata.discountAmount || '0',
                originalAmount: paymentIntent.metadata.originalAmount || paymentIntent.amount.toString(),
                receipt_url: paymentIntent.charges.data[0]?.receipt_url
            });
        } else {
            res.json({
                success: false,
                status: paymentIntent.status,
                paymentId: paymentIntent.id
            });
        }
        
    } catch (error) {
        console.error('Errore verifica pagamento:', error);
        res.status(500).json({ 
            error: 'Errore nella verifica del pagamento',
            details: error.message
        });
    }
});

// Endpoint per ottenere statistiche codici sconto (opzionale - per admin)
app.get('/api/discount-stats', (req, res) => {
    const stats = Object.entries(discountCodes).map(([code, data]) => ({
        code,
        description: data.description,
        type: data.type,
        value: data.value,
        active: data.active,
        usedCount: data.usedCount,
        maxUses: data.maxUses,
        remainingUses: data.maxUses ? data.maxUses - data.usedCount : 'Unlimited',
        validUntil: data.validUntil,
        isExpired: data.validUntil ? new Date() > data.validUntil : false
    }));
    
    res.json({ discountCodes: stats });
});

// Webhook Stripe
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
    
    // Gestisci gli eventi
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
            
            // Log del risparmio se presente
            if (paymentIntent.metadata.discountCode) {
                const savings = parseInt(paymentIntent.metadata.discountAmount) / 100;
                console.log(`🎉 Cliente ha risparmiato €${savings.toFixed(2)} con il codice ${paymentIntent.metadata.discountCode}`);
            }
            
            // Qui puoi:
            // - Inviare email di conferma con dettagli dello sconto
            // - Salvare nel database
            // - Attivare accesso al servizio
            // - Inviare notifiche
            
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

// Catch-all per API routes non trovate (usando regex invece di wildcard)
app.use(/^\/api\/.*/, (req, res) => {
    res.status(404).json({ 
        error: 'API endpoint not found',
        path: req.path 
    });
});

// Avvia il server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔑 Stripe configured: ${!!process.env.STRIPE_SECRET_KEY}`);
    console.log(`🔑 Stripe publishable key configured: ${!!process.env.STRIPE_PUBLISHABLE_KEY}`);
    console.log(`🪝 Webhook secret configured: ${!!process.env.STRIPE_WEBHOOK_SECRET}`);
    console.log(`🎫 Codici sconto disponibili: ${Object.keys(discountCodes).length}`);
    console.log(`🌐 Server ready at: http://localhost:${PORT}`);
});

// Gestione errori non catturati
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});
