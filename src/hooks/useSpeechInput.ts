/**
 * P1-6 QueryChat 拆分：Web Speech API 语音输入 hook（中文连续识别）。
 * 识别结果整段回调（调用方自行截断/回填），错误转用户可读提示。
 */
import { useEffect, useRef, useState } from 'react';

export interface SpeechInput {
  isListening: boolean;
  speechError: string | null;
  toggleSpeechRecognition: () => void;
  /** 清除错误提示条 */
  clearSpeechError: () => void;
}

export function useSpeechInput(onTranscript: (text: string) => void): SpeechInput {
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  // 回调走 ref，避免调用方内联箭头函数导致识别会话重建
  const transcriptRef = useRef(onTranscript);
  transcriptRef.current = onTranscript;

  const toggleSpeechRecognition = () => {
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setSpeechError('当前浏览器环境不支持 Web Speech 语音识别 API，请在 Chrome 或 Edge 浏览器中使用。');
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'zh-CN';

      recognition.onstart = () => {
        setIsListening(true);
        setSpeechError(null);
      };

      recognition.onresult = (event: any) => {
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        if (transcript) transcriptRef.current(transcript);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          setSpeechError('麦克风权限已被拒绝，请在浏览器地址栏侧点击允许麦克风权限。');
        } else if (event.error !== 'no-speech') {
          setSpeechError(`语音输入提示: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err: any) {
      console.error('Failed to start speech recognition:', err);
      setIsListening(false);
    }
  };

  const clearSpeechError = () => setSpeechError(null);

  // 卸载时停止识别会话，避免跨页面持续占用麦克风
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop?.();
    };
  }, []);

  return { isListening, speechError, toggleSpeechRecognition, clearSpeechError };
}
