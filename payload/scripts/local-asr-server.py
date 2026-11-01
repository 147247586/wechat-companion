"""Local SenseVoice ASR endpoint for WeChatAgent speech-recognition.

OpenAI-compatible: POST /v1/audio/transcriptions (multipart field `file`).
Loopback only, no uploads, no external network.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from email.parser import BytesParser
from email.policy import default
import array
import io
import json
import os
import re
import threading
import wave

import sherpa_onnx

HOST = '127.0.0.1'
PORT = 11231
MODEL_DIR = os.environ.get('WECHAT_ASR_MODEL', r'D:\voice-svc\asr\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')
MAX_BYTES = 2 * 1024 * 1024

print('loading SenseVoice...', flush=True)
recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=MODEL_DIR + r'\model.int8.onnx',
    tokens=MODEL_DIR + r'\tokens.txt',
    num_threads=2,
    use_itn=True,
    debug=False,
)
print('ready', flush=True)
lock = threading.Lock()


def transcribe(data):
    with wave.open(io.BytesIO(data), 'rb') as source:
        if source.getnchannels() != 1 or source.getsampwidth() != 2:
            raise ValueError('VOICE_FORMAT_UNSUPPORTED')
        if source.getframerate() != 16000:
            raise ValueError('VOICE_SAMPLE_RATE_UNSUPPORTED')
        frames = source.getnframes()
        if frames <= 0:
            raise ValueError('VOICE_AUDIO_EMPTY')
        pcm = array.array('h', source.readframes(frames))
    with lock:
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, pcm)
        recognizer.decode_stream(stream)
        return str(stream.result.text or '').strip()


def multipart_file(content_type, body):
    message = BytesParser(policy=default).parsebytes(
        b'Content-Type: ' + content_type.encode('latin-1') + b'\r\nMIME-Version: 1.0\r\n\r\n' + body
    )
    for part in message.walk():
        if part.get_content_maintype() == 'multipart':
            continue
        filename = part.get_filename()
        if not filename:
            continue
        data = part.get_payload(decode=True)
        if data:
            return data
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('%s - %s' % (self.address_string(), fmt % args), flush=True)

    def reply(self, code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self.reply(200, {'ok': True, 'model': 'sensevoice', 'service': 'local-asr'})
        return self.reply(404, {'error': 'NOT_FOUND'})

    def do_POST(self):
        if self.path != '/v1/audio/transcriptions':
            return self.reply(404, {'error': 'NOT_FOUND'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length <= 0 or length > MAX_BYTES:
                raise ValueError('VOICE_AUDIO_LIMIT')
            body = self.rfile.read(length)
            ctype = self.headers.get('Content-Type') or ''
            if not ctype.startswith('multipart/form-data'):
                raise ValueError('VOICE_REQUEST_INVALID')
            audio = multipart_file(ctype, body)
            if not audio:
                raise ValueError('VOICE_AUDIO_MISSING')
            text = transcribe(audio)
            if not text:
                raise ValueError('VOICE_TRANSCRIPT_EMPTY')
            return self.reply(200, {'text': text})
        except Exception as error:
            code = str(error)
            if not re.fullmatch(r'VOICE_[A-Z_]{3,80}', code):
                code = 'VOICE_INPUT_FAILED'
            return self.reply(400, {'error': code})


if __name__ == '__main__':
    print(f'listening on http://{HOST}:{PORT}', flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

