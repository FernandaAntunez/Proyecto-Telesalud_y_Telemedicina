# classify.py
import sys
import os
import json
import numpy as np
import joblib
import librosa
import warnings
from scipy.signal import butter, filtfilt, find_peaks

# Silenciar advertencias para no ensuciar el JSON
warnings.filterwarnings("ignore")

# ==========================================
# CLASE DE PROCESAMIENTO DE SEÑAL (Similar a tu MATLAB)
# ==========================================
class HeartSignalProcessor:
    def __init__(self, fs=2000):
        self.target_fs = fs  # Frecuencia de muestreo objetivo

    def preprocess_audio(self, file_path, duration=10):
        """
        0.1 - 0.4: Carga, mono, normalización y recorte
        """
        # Cargar audio (librosa convierte a mono y normaliza a -1,1 por defecto)
        try:
            x, fs = librosa.load(file_path, sr=self.target_fs, duration=duration)
        except Exception as e:
            print(f"Error leyendo {file_path}: {e}", file=sys.stderr)
            return None, None

        # 0.2 Si es estéreo, convertir a mono (librosa ya lo hace)
        # 0.3 Normalizar estrictamente a [-1, 1] (como en tu Matlab)
        x = (x - np.min(x)) / (np.max(x) - np.min(x) + 1e-8)
        x = x * 2 - 1
        
        return x, fs

    def compute_shannon_envelope(self, x, fs):
        """
        1.1 - 2.2: Envolvente de Shannon y Filtro Pasa Bajas (LPF)
        Retorna tanto la envolvente como datos intermedios para graficar
        """
        # 1.1 Probabilidad normalizada
        p = np.abs(x)
        p = p / (np.max(p) + 1e-8)

        # 1.2 Energía de Shannon (-p * log(p))
        E = -p * np.log10(p + 1e-8)

        # 1.3 Estandarización
        E_z = (E - np.mean(E)) / (np.std(E) + 1e-8)
        # Normalizar a [0, 1]
        Env0 = (E_z - np.min(E_z)) / (np.max(E_z) - np.min(E_z) + 1e-8)

        # 2.1 LPF (Filtro Butterworth)
        fc = 10  # Corte en Hz (ajustado a tu código MATLAB: 10 Hz)
        nyq = 0.5 * fs
        b, a = butter(4, fc / nyq, btype='low')
        Env = filtfilt(b, a, Env0)

        # 2.2 Normalización final
        Env = (Env - np.min(Env)) / (np.max(Env) - np.min(Env) + 1e-8)
        
        return Env

    def segment_cycles(self, Env, fs):
        """
        5.1 - 5.3: Segmentación basada en umbrales y duración
        """
        # Umbral adaptativo
        threshold = np.mean(Env) * 1.1
        
        # Encontrar regiones por encima del umbral
        is_high = Env > threshold
        diff_sig = np.diff(is_high.astype(int))
        starts = np.where(diff_sig == 1)[0]
        ends = np.where(diff_sig == -1)[0]

        if len(starts) == 0 or len(ends) == 0:
            return []
        if ends[0] < starts[0]: ends = ends[1:]
        if starts[-1] > ends[-1]: starts = starts[:-1]

        min_rr = int(0.30 * fs)
        
        # Detectar picos prominentes
        peaks, _ = find_peaks(Env, height=threshold, distance=int(0.15*fs))
        
        if len(peaks) < 2:
            return []

        cycle_regions = []
        window_size = int(0.5 * fs) 
        
        for p in peaks:
            start = max(0, p - window_size // 2)
            end = min(len(Env), p + window_size // 2)
            if (end - start) > min_rr:
                cycle_regions.append((start, end))
                
        return cycle_regions

    def extract_features(self, x, fs, cycles):
        """
        Bloque 5: Extracción de MFCCs
        """
        features_list = []
        
        for (start, end) in cycles:
            segment = x[start:end]
            
            if len(segment) < 512: continue

            mfccs = librosa.feature.mfcc(y=segment, sr=fs, n_mfcc=13, n_fft=2048, hop_length=512)
            
            mfcc_mean = np.mean(mfccs, axis=1)
            mfcc_std = np.std(mfccs, axis=1)
            
            feat_vec = np.concatenate((mfcc_mean, mfcc_std))
            features_list.append(feat_vec)
            
        return np.array(features_list)
    
    def prepare_graph_data(self, x, Env, fs, max_points=2000):
        """
        Prepara datos para las gráficas, decimando si es necesario
        """
        time = np.arange(len(x)) / fs
        
        # Decimar si hay demasiados puntos (para optimizar transferencia)
        if len(x) > max_points:
            step = len(x) // max_points
            x_decimated = x[::step]
            Env_decimated = Env[::step]
            time_decimated = time[::step]
        else:
            x_decimated = x
            Env_decimated = Env
            time_decimated = time
        
        return {
            'waveform': {
                'time': time_decimated.tolist(),
                'signal': x_decimated.tolist()
            },
            'envelope': {
                'time': time_decimated.tolist(),
                'signal': Env_decimated.tolist()
            }
        }

def main():
    response = {"status": "error", "message": "Error desconocido"}
    
    try:
        if len(sys.argv) < 2:
            raise Exception("No se recibió la ruta del archivo")
        
        file_path = sys.argv[1]
        model_path = os.path.join(os.path.dirname(__file__), 'heart_sound_model.pkl')
        
        if not os.path.exists(model_path):
            raise Exception("Modelo no encontrado. Ejecuta train.py primero.")
            
        clf = joblib.load(model_path)
        processor = HeartSignalProcessor()
        
        # Procesar audio
        x, fs = processor.preprocess_audio(file_path)
        if x is None: 
            raise Exception("Error leyendo audio")
        
        # Calcular envolvente de Shannon
        Env = processor.compute_shannon_envelope(x, fs)
        
        # Preparar datos para gráficas
        graph_data = processor.prepare_graph_data(x, Env, fs)
        
        # Segmentar y extraer características
        cycles = processor.segment_cycles(Env, fs)
        feats = processor.extract_features(x, fs, cycles)
        
        if len(feats) == 0:
            response = {
                "status": "success", 
                "class": "No concluyente", 
                "confidence": 0, 
                "cycles": 0,
                "graph_data": graph_data
            }
        else:
            preds = clf.predict(feats)
            unique, counts = np.unique(preds, return_counts=True)
            majority = unique[np.argmax(counts)]
            conf = (np.max(counts) / len(preds)) * 100
            
            response = {
                "status": "success",
                "class": majority,
                "confidence": round(conf, 2),
                "cycles": len(preds),
                "graph_data": graph_data
            }
            
    except Exception as e:
        response["message"] = str(e)

    print(json.dumps(response))

if __name__ == "__main__":
    main()