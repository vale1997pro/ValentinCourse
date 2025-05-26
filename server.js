// server.js
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

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

// Endpoint per creare un Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        console.log('Creating payment intent for:', req.body);
        
        const { email, name, phone } = req.body;
        
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
        
        // Crea il Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: 100, // €1.00 in centesimi
            currency: 'eur',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                email: email,
                name: name,
                phone: phone || '',
                product: 'vfx-consultation',
                productId: 'cons-001'
            },
            description: 'VFX Career Consultation with Valentin Procida'
        });
        
        console.log('Payment Intent creato:', paymentIntent.id);
        
        res.json({
            clientSecret: paymentIntent.client_secret,
            paymentIntentId: paymentIntent.id
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
                currency: paymentIntent.currency
            });
            
            // Qui puoi:
            // - Inviare email di conferma
            // - Salvare nel database
            // - Attivare accesso al servizio
            
            break;
            
        case 'payment_intent.payment_failed':
            const failedPayment = event.data.object;
            console.log('❌ Pagamento fallito:', {
                id: failedPayment.id,
                error: failedPayment.last_payment_error?.message
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
