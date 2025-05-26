# Usa l'immagine base Node
FROM node:18

# Crea directory e copia tutto
WORKDIR /app
COPY . .

# Installa le dipendenze
RUN npm install

# Espone la porta (Cloud Run userà la porta d’ambiente PORT)
EXPOSE 8080

# Comando per avviare l’app
CMD ["node", "server.js"]
