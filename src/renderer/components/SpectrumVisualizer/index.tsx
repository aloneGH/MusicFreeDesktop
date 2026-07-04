import React, { useEffect, useRef } from "react";
import "./style.scss";

interface SpectrumVisualizerProps {
    analyserNode: AnalyserNode;
}

const SpectrumVisualizer: React.FC<SpectrumVisualizerProps> = ({ analyserNode }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!analyserNode) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const canvasCtx = canvas.getContext("2d");
        if (!canvasCtx) return;

        // --- Visual Enhancements ---
        analyserNode.fftSize = 256;
        // Make bars react faster to the beat
        analyserNode.smoothingTimeConstant = 0.75;
        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        let animationFrameId: number;

        const draw = () => {
            animationFrameId = requestAnimationFrame(draw);
            analyserNode.getByteFrequencyData(dataArray);
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

            const barWidth = (canvas.width / bufferLength);
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                // Exaggerate height differences with a power function for more "punch"
                const barHeight = Math.pow(dataArray[i] / 255, 2.5) * canvas.height;

                // Cycle through hues for a rainbow effect
                const hue = i * 2.5;
                canvasCtx.fillStyle = `hsl(${hue}, 100%, 60%)`;

                canvasCtx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
                x += barWidth;
            }
        };

        draw();

        const handleResize = () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        };
        window.addEventListener("resize", handleResize);

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener("resize", handleResize);
        };
    }, [analyserNode]);

    return <canvas ref={canvasRef} className="spectrum-visualizer" />;
};

export default SpectrumVisualizer;
