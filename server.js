// server.js
require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:8000'
}));

// Test endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running!', timestamp: new Date() });
});

// Endpoint per creare un Payment Intent
app.post('/api/create-payment-intent', async (req, res) => {
    try {
        const { email, name } = req.body;
        
        // Validazione base
        if (!email || !name) {
            return res.status(400).json({ 
                error: 'Email e nome sono richiesti' 
            });
        }
        
        // Crea il Payment Intent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: 4900, // €49.00 in centesimi
            currency: 'eur',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                email: email,
                name: name,
                product: 'corso-web-development',
                productId: 'corso-001'
            },
            description: 'Corso Completo Web Development'
        });
        
        // Opzionale: Salva l'ordine nel database qui
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

// Endpoint per verificare il pagamento (opzionale ma consigliato)
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { paymentIntentId } = req.body;
        
        const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
        
        if (paymentIntent.status === 'succeeded') {
            // Pagamento confermato!
            // Qui puoi:
            // 1. Inviare email con il corso
            // 2. Creare accesso utente
            // 3. Salvare nel database
            
            console.log('Pagamento verificato per:', paymentIntent.metadata.email);
            
            res.json({
                success: true,
                email: paymentIntent.metadata.email,
                amount: paymentIntent.amount,
                receipt_url: paymentIntent.charges.data[0]?.receipt_url
            });
        } else {
            res.json({
                success: false,
                status: paymentIntent.status
            });
        }
        
    } catch (error) {
        console.error('Errore verifica pagamento:', error);
        res.status(500).json({ 
            error: 'Errore nella verifica del pagamento' 
        });
    }
});

// Webhook Stripe (per notifiche automatiche)
app.post('/api/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Aggiungi questo al .env
    
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Gestisci gli eventi
    switch (event.type) {
        case 'payment_intent.succeeded':
            const paymentIntent = event.data.object;
            console.log('💰 Pagamento ricevuto!', paymentIntent.metadata.email);
            
            // Invia email automatica, attiva accesso, etc.
            // await sendCourseEmail(paymentIntent.metadata.email);
            
            break;
            
        case 'payment_intent.payment_failed':
            console.log('❌ Pagamento fallito:', event.data.object.id);
            break;
            
        default:
            console.log(`Evento non gestito: ${event.type}`);
    }
    
    res.json({received: true});
});

// Endpoint per ottenere la chiave pubblica (utile per il frontend)
app.get('/api/config', (req, res) => {
    res.json({
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
});

// Avvia il server
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📝 Test API: http://localhost:${PORT}/api/health`);
});

// Gestione errori non catturati
process.on('unhandledRejection', (err) => {
    console.error('Unhandled Promise Rejection:', err);
});