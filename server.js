const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const mysql = require('mysql2');
const session = require('express-session');
const bcrypt = require('bcrypt');


const app = express();
const PORT = 5000;
//Sirve los archivos estáticos desde la carpeta 'uploads',
//Esto crea una ruta virtual "/uploads" que mapea a la carpeta del sistema de archivos.
app.use('/uploads', express.static('uploads'));
// Middleware para parsear JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));




// Configuración de la sesión
app.use(session({
  secret: 'secretKey',
  resave: false,
  saveUninitialized: false,
}));
app.use(express.urlencoded({ extended: true }));
// Conexión a MySQL
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'ROSITA12',
    database: 'backend_'
});
connection.connect();

// Verificar conexión a MySQL
connection.connect((err) => {
    if (err) {
        console.error('Error conectando a MySQL:', err.message);
        process.exit(1);
    }
    console.log('Conectado a MySQL exitosamente');
});

// Configuración de almacenamiento de Multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dir = './uploads';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});



// Filtro de archivos (Solo MP3)
const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'audio/mpeg' || file.originalname.toLowerCase().endsWith('.mp3')) {
        cb(null, true);
    } else {
        cb(new Error('Formato no válido. Sólo se permiten archivos MP3.'), false);
    }
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Ruta principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// Ruta subir audios (MEJORADA)
app.post('/upload', upload.single('cancion'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('Por favor sube un archivo MP3 válido.');
    }

    const pacienteInfo = req.body.paciente_info || 'Sin información del paciente';
    const filePath = path.resolve(req.file.path);
    const scriptPath = path.join(__dirname, 'classify.py');
    const isWindows = process.platform === 'win32';
    
    const pythonExecutable = isWindows
        ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
        : path.join(__dirname, 'venv', 'bin', 'python');

    console.log(`--- NUEVA PETICIÓN ---`);
    console.log(`Sistema Operativo: ${process.platform}`);
    console.log(`Analizando: ${req.file.filename}`);
    console.log(`Paciente: ${pacienteInfo}`);

    const pythonProcess = spawn(pythonExecutable, [scriptPath, filePath]);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        outputData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        console.error(`Python Log/Error: ${data}`);
    });

    pythonProcess.on('close', (code) => {
        console.log(`Proceso finalizado con código ${code}`);

        let result = null;
        try {
            result = JSON.parse(outputData.trim());
        } catch (e) {
            console.error("Error al parsear JSON:", outputData);
            return res.status(500).send(`
                <div style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2 style="color: red;">Error Interno</h2>
                    <p>El sistema de IA no devolvió una respuesta válida.</p>
                    <br><a href="/">Intentar de nuevo</a>
                </div>
            `);
        }

        if (result.status === 'error') {
            return res.status(500).send(`
                <div style="font-family: Arial; text-align: center; padding: 50px;">
                    <h2 style="color: orange;">No se pudo analizar</h2>
                    <p>${result.message}</p>
                    <a href="/">Volver</a>
                </div>
            `);
        }

        // Preparar graph_data para guardado
        let graphDataString = null;
        if (result.graph_data) {
            try {
                // Si graph_data ya es un objeto, convertirlo a string
                graphDataString = typeof result.graph_data === 'string' 
                    ? result.graph_data 
                    : JSON.stringify(result.graph_data);
            } catch (e) {
                console.error('Error procesando graph_data:', e);
            }
        }

        // ✅ Insertar en base de datos
        const insertQuery = `
            INSERT INTO analisis_audios 
            (nombre_archivo, nombre_original, ruta_archivo, clasificacion, confianza, ciclos_latidos, paciente_info, graph_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const values = [
            req.file.filename,
            req.file.originalname,
            filePath,
            result.class,
            parseFloat(result.confidence),
            parseInt(result.cycles),
            pacienteInfo,
            graphDataString
        ];

        connection.query(insertQuery, values, (err, dbResult) => {
            if (err) {
                console.error('❌ Error al guardar en MySQL:', err);
            } else {
                console.log(`✅ Análisis guardado en BD con ID: ${dbResult.insertId}`);
            }

            // Generar respuesta HTML
            const isNormal = result.class.toLowerCase() === 'normal';
            const color = isNormal ? '#28a745' : '#dc3545';
            const icon = isNormal ? '💚' : '⚠️';
            const title = isNormal ? 'CORAZÓN NORMAL' : 'ANOMALÍA DETECTADA';
            
            // ID del análisis recién insertado (para enlace a detalle)
            const analisisId = dbResult ? dbResult.insertId : null;

            res.send(`
                <!DOCTYPE html>
                <html lang="es">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Resultado del Análisis</title>
                    <style>
                        body { 
                            font-family: 'Segoe UI', Arial, sans-serif; 
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                            min-height: 100vh; 
                            display: flex; 
                            justify-content: center; 
                            align-items: center; 
                            padding: 20px; 
                        }
                        .card { 
                            background: white; 
                            padding: 40px; 
                            border-radius: 15px; 
                            box-shadow: 0 10px 25px rgba(0,0,0,0.1); 
                            max-width: 600px; 
                            width: 100%; 
                        }
                        h1 { 
                            color: ${color}; 
                            margin: 0 0 10px 0; 
                            font-size: 2rem; 
                            text-align: center; 
                        }
                        h3 { 
                            color: #333; 
                            font-weight: normal; 
                            margin-bottom: 20px; 
                            text-align: center; 
                        }
                        .stats { 
                            background-color: #f8f9fa; 
                            padding: 20px; 
                            border-radius: 10px; 
                            margin: 20px 0; 
                            border-left: 5px solid ${color}; 
                        }
                        .stats p { 
                            margin: 10px 0; 
                            font-size: 1.1rem; 
                            color: #555; 
                        }
                        .btn { 
                            display: inline-block; 
                            padding: 12px 24px; 
                            background: #007bff; 
                            color: white; 
                            text-decoration: none; 
                            border-radius: 6px; 
                            font-weight: bold; 
                            margin: 5px; 
                            transition: all 0.3s ease;
                        }
                        .btn:hover { 
                            background: #0056b3; 
                            transform: translateY(-2px);
                        }
                        .btn-secondary { 
                            background: #6c757d; 
                        }
                        .btn-secondary:hover {
                            background: #545b62;
                        }
                        .btn-success {
                            background: #28a745;
                        }
                        .btn-success:hover {
                            background: #218838;
                        }
                        .file-info { 
                            font-size: 0.9em; 
                            color: #999; 
                            margin-top: 20px; 
                            text-align: center; 
                        }
                        .success-msg { 
                            color: #28a745; 
                            font-size: 0.9em; 
                            text-align: center; 
                            margin-top: 10px;
                        }
                        .btn-container { 
                            text-align: center; 
                            margin-top: 20px; 
                            display: flex;
                            flex-wrap: wrap;
                            justify-content: center;
                            gap: 10px;
                        }
                        .highlight-box {
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                            padding: 15px;
                            border-radius: 10px;
                            margin: 15px 0;
                            text-align: center;
                        }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h1>${icon} ${title}</h1>
                        <h3>Diagnóstico preliminar: <strong>${result.class}</strong></h3>
                        
                        <div class="stats">
                            <p>🔍 <strong>Confianza del modelo:</strong> ${result.confidence}%</p>
                            <p>💓 <strong>Latidos analizados:</strong> ${result.cycles}</p>
                            <p>👤 <strong>Paciente:</strong> ${pacienteInfo}</p>
                        </div>

                        ${!err ? '<p class="success-msg">✅ Análisis guardado en la base de datos</p>' : ''}

                        ${analisisId ? `
                            <div class="highlight-box">
                                <p style="margin: 0 0 10px 0; font-size: 1.1rem;">
                                    📊 ¿Quieres ver las gráficas detalladas?
                                </p>
                                <a href="/analisis/${analisisId}" class="btn btn-success" style="background: white; color: #764ba2;">
                                    🔬 Ver Análisis Completo
                                </a>
                            </div>
                        ` : ''}

                        <div class="btn-container">
                            <a href="/" class="btn">🏠 Nuevo Análisis</a>
                            <a href="/historial" class="btn btn-secondary">📊 Ver Historial</a>
                        </div>
                        
                        <p class="file-info">Archivo: ${req.file.originalname}</p>
                    </div>
                </body>
                </html>
            `);
        });
    });
});

//Login
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.send('Email y contraseña son requeridos');
    }

    // Buscar usuario por EMAIL
    connection.query('SELECT * FROM usuarios WHERE email = ?', [email], (err, results) => {
        if (err) {
            console.error('Error en login:', err);
            return res.send('Error del servidor');
        }

        if (results.length === 0) {
            return res.send('Usuario no encontrado. <a href="/login">Intentar de nuevo</a>');
        }

        const user = results[0];
        
        // Comparar contraseña 
        if (password === user.password) {
            // Crear sesión
            req.session.userId = user.id;
            req.session.userEmail = user.email;
            req.session.userName = user.nombre_completo;
            
            // Redirigir al dashboard
            res.redirect('/');
        } else {
            res.send('Contraseña incorrecta. <a href="/login">Intentar de nuevo</a>');
        }
    });
});

// Cerrar sesión
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Registro
app.get('/registro', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'registro.html'));
});
app.post('/registro', async (req, res) => {
    const { nombre_completo, email, password } = req.body;
    
    if (!nombre_completo || !email || !password) {
        return res.send('Todos los campos son requeridos');
    }
    
    // Guardar contraseña SIN hashear (INSEGURO)
    connection.query('INSERT INTO usuarios (nombre_completo, email, password, rol) VALUES (?, ?, ?, ?)', 
        [nombre_completo, email, password, 'paciente'], (err) => {
        if (err) {
            console.error('Error al registrar:', err);
            return res.send('Error al registrar el usuario. El email podría estar duplicado.');
        }
        
        // Crear entrada en tabla pacientes
        connection.query('INSERT INTO pacientes (usuario_id) VALUES (LAST_INSERT_ID())', (err) => {
            if (err) console.error('Error creando paciente:', err);
            res.send('<h2>✅ Registro exitoso</h2><p><a href="/login">Ir a Login</a></p>');
        });
    });
});

// Ruta para mostrar la página del historial (HTML)
app.get('/historial', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'historial.html'));
});

// API para obtener los datos (JSON)
app.get('/api/historial', (req, res) => {
    const query = 'SELECT * FROM analisis_audios ORDER BY fecha_analisis DESC LIMIT 50';
    
    connection.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener historial:', err);
            return res.status(500).json({ error: 'Error al obtener historial' });
        }
        res.json(results);
    });
});

// Ruta para ver detalle de un análisis específico
app.get('/analisis/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'analisis-detalle.html'));
});

// API para obtener datos de un análisis específico CON AUDIO Y GRÁFICAS
app.get('/api/analisis/:id', (req, res) => {
    const id = req.params.id;
    
    const query = 'SELECT * FROM analisis_audios WHERE id = ?';
    
    connection.query(query, [id], (err, results) => {
        if (err || results.length === 0) {
            return res.status(404).json({ error: 'Análisis no encontrado' });
        }
        
        const analisis = results[0];
        const audioPath = analisis.ruta_archivo;
        
        // Preparar respuesta base
        let responseData = {
            id: analisis.id,
            nombre_original: analisis.nombre_original,
            clasificacion: analisis.clasificacion,
            confianza: analisis.confianza,
            ciclos_latidos: analisis.ciclos_latidos,
            fecha_analisis: analisis.fecha_analisis,
            paciente_info: analisis.paciente_info,
            audio_base64: null,
            audio_error: null,
            graph_data: null
        };
        
        // Verificar si el archivo existe y leer audio
        if (fs.existsSync(audioPath)) {
            try {
                // Leer archivo y convertir a base64
                const audioBuffer = fs.readFileSync(audioPath);
                responseData.audio_base64 = audioBuffer.toString('base64');
            } catch (readError) {
                console.error('Error leyendo archivo de audio:', readError);
                responseData.audio_error = 'Error al leer archivo de audio';
            }
        } else {
            responseData.audio_error = 'Archivo de audio no encontrado';
        }
        
        // Intentar parsear graph_data si existe
        if (analisis.graph_data) {
            try {
                responseData.graph_data = typeof analisis.graph_data === 'string' 
                    ? JSON.parse(analisis.graph_data) 
                    : analisis.graph_data;
            } catch (parseError) {
                console.error('Error parseando graph_data:', parseError);
                responseData.graph_data = null;
            }
        }
        
        res.json(responseData);
    });
});

// Ruta para mostrar la página de estadísticas (HTML)
app.get('/estadisticas', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'estadisticas.html'));
});

// API para obtener estadísticas (JSON)
app.get('/api/estadisticas', (req, res) => {
    const query = `
        SELECT 
            clasificacion,
            COUNT(*) as total,
            AVG(confianza) as confianza_promedio
        FROM analisis_audios 
        GROUP BY clasificacion
    `;
    
    connection.query(query, (err, results) => {
        if (err) {
            console.error('Error al obtener estadísticas:', err);
            return res.status(500).json({ error: 'Error al obtener estadísticas' });
        }
        res.json(results);
    });
});


// Ruta para servir la página de usuarios (usuarios.html)
// Esto soluciona el error "Cannot GET /usuarios" si intentas acceder a esa URL.
app.get('/usuarios', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'usuarios.html'));
});
// Ruta para obtener la lista de todos los usuarios
app.get('/api/usuarios', (req, res) => {
    // Seleccionamos las columnas necesarias, excluyendo contraseñas u otros datos sensibles.
    connection.query(
        'SELECT id, nombre_completo, email, rol, fecha_registro, ultimo_acceso FROM usuarios', 
        (err, results) => {
            if (err) {
                console.error('Error al obtener usuarios:', err);
                // Devolvemos un error 500 al cliente
                return res.status(500).json({ error: 'Error al obtener los datos de usuarios' });
            }
            // Devolvemos los resultados como JSON
            res.json(results);
        }
    );
});

// Manejo de errores de Multer
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(500).send(`Error de subida: ${err.message}`);
    } else if (err) {
        return res.status(500).send(`Error: ${err.message}`);
    }
    next();
});

// Cerrar conexión MySQL al detener el servidor
process.on('SIGINT', () => {
    connection.end((err) => {
        if (err) console.error('Error cerrando MySQL:', err);
        console.log('Conexión MySQL cerrada');
        process.exit(0);
    });
});

app.listen(PORT, () => {
    console.log(` Servidor escuchando en el puerto http://35.188.48.188:${PORT}`);
    console.log(` Modo: ${process.platform === 'win32' ? 'Windows (Local)' : 'Linux (Servidor)'}`);
});