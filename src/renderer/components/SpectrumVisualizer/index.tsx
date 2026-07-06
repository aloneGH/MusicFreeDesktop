import React, { useEffect, useRef } from "react";
import "./style.scss";
import { usePlayerState } from "@renderer/core/track-player/hooks";
import { PlayerState } from "@/common/constant";

interface SpectrumVisualizerProps {
    analyserNode: AnalyserNode;
}

// Soft-knee peak limiter to prevent flat-topped window-edge clipping during high-volume climaxes.
// Below the threshold, it is 100% linear; above, it curves smoothly towards the boundary.
const limitHeight = (h: number, limit: number) => {
    const threshold = limit * 0.65;
    if (h < threshold) return h;
    return threshold + (limit - threshold) * Math.tanh((h - threshold) / (limit - threshold));
};

const SpectrumVisualizer: React.FC<SpectrumVisualizerProps> = ({ analyserNode }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const playerState = usePlayerState();

    useEffect(() => {
        if (!analyserNode) return;

        const canvas = canvasRef.current;
        if (!canvas) return;

        const canvasCtx = canvas.getContext("2d");
        if (!canvasCtx) return;

        // If music is paused or stopped, clear the canvas and immediately exit to avoid CPU consumption!
        if (playerState !== PlayerState.Playing) {
            canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        // Define layout dimensions in the outer scope to avoid querying window size in every animation frame
        let width = window.innerWidth;
        let height = window.innerHeight;
        let baselineY = height - 64;
        if (!canvasCtx) return;

        // Retina Display scaling (capped at 1.0 for visualizer to maximize rendering performance)
        const dpr = 1.0;
        canvas.width = window.innerWidth * dpr;
        canvas.height = window.innerHeight * dpr;
        canvasCtx.scale(dpr, dpr);

        // Create a tiny 64x64 noise pattern to apply dithering and prevent color banding in gradients
        const noiseCanvas = document.createElement("canvas");
        noiseCanvas.width = 64;
        noiseCanvas.height = 64;
        const noiseCtx = noiseCanvas.getContext("2d");
        let noisePattern: CanvasPattern | null = null;
        if (noiseCtx) {
            const noiseImgData = noiseCtx.createImageData(64, 64);
            const noiseData = noiseImgData.data;
            for (let i = 0; i < noiseData.length; i += 4) {
                const val = Math.floor(Math.random() * 255);
                noiseData[i] = val;
                noiseData[i + 1] = val;
                noiseData[i + 2] = val;
                noiseData[i + 3] = Math.floor(Math.random() * 8); // Subtly increased opacity (approx 0% to 2.7%, avg 1.37%) for better dithering
            }
            noiseCtx.putImageData(noiseImgData, 0, 0);
            noisePattern = canvasCtx.createPattern(noiseCanvas, "repeat");
        }


        // Store original values of shared AnalyserNode configuration to restore them during cleanup
        const originalFftSize = analyserNode.fftSize;
        const originalSmoothing = analyserNode.smoothingTimeConstant;

        // --- Visual Enhancements ---
        analyserNode.fftSize = 1024;
        // Make bars react faster to the beat
        analyserNode.smoothingTimeConstant = 0.6;
        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const smoothedValues = new Float32Array(bufferLength);

        // Precompute log mapping lookup table to avoid expensive Math.pow/Math.floor calls at 60fps
        const minBin = 1;
        const maxBin = Math.max(minBin + 1, Math.floor(bufferLength * 0.85));
        const sampleStep = 8;
        const logLookupTable: Array<{ lowIndex: number; highIndex: number; frac: number }> = [];
        
        for (let i = 0; i < bufferLength; i += sampleStep) {
            const currentT = i / (bufferLength - 1);
            const logIndex = minBin * Math.pow(maxBin / minBin, currentT);
            const lowIndex = Math.floor(logIndex);
            const highIndex = Math.min(bufferLength - 1, Math.ceil(logIndex));
            const frac = logIndex - lowIndex;
            logLookupTable.push({ lowIndex, highIndex, frac });
        }

        // Reusable DOMMatrix to prevent garbage collection GC pressure at 60fps
        const noiseMatrix = typeof DOMMatrix !== "undefined" ? new DOMMatrix() : null;

        // Wave, beat, and rhythm variables
        let phase1 = 0; // Phase tracker for Wave 1 (Sub-bass driven)
        let phase2 = 0; // Phase tracker for Wave 2 (Midrange driven)
        let phase3 = 0; // Phase tracker for Wave 3 (Treble driven)
        let phaseVocal = 0; // Phase tracker for Vocal Wave (Vocal driven)
        let baseHue = 0; // Color wheel tracker for smooth rainbow color cycling
        let smoothedVolume = 0;
        let rhythmActivity = 0;
        let smoothedVocalX = 0.5;
        let smoothedVocalAmp = 0;
        let maxVolumeTracked = 0.3; // Track historical peak volume for auto-gain normalization
        let silentFramesCount = 0;   // Track silence frames to enter zero-CPU idle sleep state
        let sleepTimeoutId: number | null = null; // Sleep state polling timer ID
        const bassEnergyHistory: number[] = [];
        const historyLimit = 30;



        let animationFrameId: number;
        let lastFrameTime = 0;
        const fpsInterval = 1000 / 60; // Throttle rendering loop to 60 FPS maximum (crucial for 120Hz/ProMotion Mac screens)

        const draw = (timestamp: number) => {
            const elapsed = timestamp - lastFrameTime;
            if (elapsed < fpsInterval) {
                animationFrameId = requestAnimationFrame(draw);
                return;
            }
            lastFrameTime = timestamp - (elapsed % fpsInterval);

            analyserNode.getByteFrequencyData(dataArray);

            // Loop Fusion: Track maximum amplitude and apply asymmetric temporal smoothing in a single pass to save L1 cache/CPU bounds
            let frameMax = 0;
            for (let i = 0; i < bufferLength; i++) {
                const target = dataArray[i];
                if (target > frameMax) {
                    frameMax = target;
                }
                
                if (target > smoothedValues[i]) {
                    smoothedValues[i] += (target - smoothedValues[i]) * 0.25; // rise fast
                } else {
                    smoothedValues[i] += (target - smoothedValues[i]) * 0.12; // decay slowly
                }
            }

            // Zero-CPU Idle Sleep Optimization: if silent for > 60 frames, freeze loop rendering
            if (frameMax < 2) {
                silentFramesCount++;
                if (silentFramesCount > 60) {
                    if (silentFramesCount === 61) {
                        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);
                    }
                    // Reset smoothed values so visualizer starts fresh on wake up
                    smoothedVolume = 0;
                    rhythmActivity = 0;
                    smoothedVocalAmp = 0;
                    // Trigger slow audio polling check (4 times a second instead of 60fps) to drop CPU to absolute 0%
                    scheduleSleepPoll();
                    return;
                }
            } else {
                silentFramesCount = 0;
            }

            const frameMaxNorm = frameMax / 255;
            if (frameMaxNorm > maxVolumeTracked) {
                maxVolumeTracked += (frameMaxNorm - maxVolumeTracked) * 0.15; // fast attack
            } else {
                maxVolumeTracked += (frameMaxNorm - maxVolumeTracked) * 0.003; // slow decay
            }
            maxVolumeTracked = Math.max(0.15, Math.min(1.0, maxVolumeTracked));

            canvasCtx.clearRect(0, 0, width, height);

            // Draw ambient room glow that breathes/pulses with volume and beat
            const drawAmbientGlow = () => {
                const glowRadius = height * (0.35 + smoothedVolume * 0.45);
                const glowGradient = canvasCtx.createRadialGradient(
                    width / 2, baselineY, 10,
                    width / 2, baselineY, glowRadius,
                );
                const intensity = 0.08 + rhythmActivity * 0.12;
                glowGradient.addColorStop(0, `hsla(${baseHue}, 100%, 60%, ${intensity})`);
                glowGradient.addColorStop(0.5, `hsla(${(baseHue + 60) % 360}, 100%, 60%, ${intensity * 0.5})`);
                glowGradient.addColorStop(1, "rgba(0, 0, 0, 0)");
                
                canvasCtx.fillStyle = glowGradient;
                canvasCtx.beginPath();
                canvasCtx.arc(width / 2, baselineY, glowRadius, 0, Math.PI * 2);
                canvasCtx.fill();

                // Noise pattern drawing removed here; applied once at the end of the frame for high performance
            };
            drawAmbientGlow();

            // Calculate current average volume across all frequencies
            let sumVolume = 0;
            for (let i = 0; i < bufferLength; i++) {
                sumVolume += dataArray[i];
            }
            const currentVolume = sumVolume / bufferLength / 255;
            smoothedVolume += (currentVolume - smoothedVolume) * 0.08; // Smooth track

            // Calculate current bass energy (average of low frequency bins 0 to 23 for fftSize 1024)
            let currentBassEnergy = 0;
            const bassBinsCount = 24;
            for (let i = 0; i < bassBinsCount; i++) {
                currentBassEnergy += dataArray[i];
            }
            currentBassEnergy /= bassBinsCount;

            // Calculate average bass energy from history
            let averageBassEnergy = 0;
            if (bassEnergyHistory.length > 0) {
                let sumBass = 0;
                for (let j = 0; j < bassEnergyHistory.length; j++) {
                    sumBass += bassEnergyHistory[j];
                }
                averageBassEnergy = sumBass / bassEnergyHistory.length;
            }

            // Update history
            bassEnergyHistory.push(currentBassEnergy);
            if (bassEnergyHistory.length > historyLimit) {
                bassEnergyHistory.shift();
            }

            // Rhythm activity: how much the current beat stands out from recent history
            const bassDiff = Math.max(0, currentBassEnergy - averageBassEnergy) / 255;
            rhythmActivity += (bassDiff - rhythmActivity) * 0.06; // Smooth activity tracking

            // Calculate Midrange Energy (Bins 8 to 31, ~344Hz to 1335Hz) for Wave 2
            let sumMid = 0;
            const midStart = 8;
            const midEnd = 31;
            for (let i = midStart; i <= midEnd; i++) {
                sumMid += dataArray[i];
            }
            const midEnergy = sumMid / (midEnd - midStart + 1) / 255;

            // Calculate Treble Energy (Bins 32 to 120, ~1378Hz to 5168Hz) for Wave 3
            let sumTreble = 0;
            const trebleStart = 32;
            const trebleEnd = 120;
            for (let i = trebleStart; i <= trebleEnd; i++) {
                sumTreble += dataArray[i];
            }
            const trebleEnergy = sumTreble / (trebleEnd - trebleStart + 1) / 255;

            // Decouple phase updates using multi-band acoustics
            // Wave 1 (Back): Driven by Bass
            phase1 += 0.008 + (currentBassEnergy / 255) * 0.09;
            // Wave 2 (Middle): Driven by Midrange
            phase2 += 0.010 + midEnergy * 0.08;
            // Wave 3 (Front): Driven by Treble
            phase3 += 0.013 + trebleEnergy * 0.11;
            // Vocal Wave: Driven by vocal amplitude
            phaseVocal += 0.015 + smoothedVocalAmp * 0.08;

            // Wave density (frequency of sine waves) stretches/compresses waves based on rhythm activity
            const densityScale = 128 / bufferLength;
            const waveDensity = (0.06 + rhythmActivity * 0.12) * densityScale;

            // Update baseHue with full-spectrum color cycling (speeds up during high rhythm activity)
            baseHue = (baseHue + 0.12 + rhythmActivity * 0.5) % 360;

            // Vocal melody track detection (narrowed search range to target the exact fundamental singing pitch window: ~172Hz to ~1033Hz)
            let maxVocalAmp = 0;
            let vocalPeakBin = 12;
            const vocalStartBin = 4;  // ~172Hz (fundamental start)
            const vocalEndBin = 24;   // ~1033Hz (fundamental end)
            for (let i = vocalStartBin; i <= vocalEndBin; i++) {
                // Apply a bell-curve bandpass weighting centered at G4 (~516Hz, bin 12)
                // This maximizes response to vocal cores and suppresses low bass/drums and high snare/instrument noise
                const centerVocal = 12;
                const sigmaVocal = 7;
                const weight = Math.exp(-((i - centerVocal) * (i - centerVocal)) / (2 * sigmaVocal * sigmaVocal));
                
                const weightedAmp = smoothedValues[i] * weight;
                if (weightedAmp > maxVocalAmp) {
                    maxVocalAmp = weightedAmp;
                    vocalPeakBin = i;
                }
            }

            // Auto-gain normalized vocal amplitude
            const vocalAmpNorm = Math.min(1.0, (maxVocalAmp / 255) / maxVolumeTracked);

            // Target vocal X position (pitch) - smoothed to glide gracefully like a ribbon
            const pitchFactor = (vocalPeakBin - vocalStartBin) / (vocalEndBin - vocalStartBin);
            const targetVocalX = 0.15 + 0.7 * pitchFactor;

            // Vocal Position Memory Lock: only update pitch position when there is active singing.
            // This prevents the vocal ribbon from randomly drifting to instrument noise during breaths or quiet parts.
            if (vocalAmpNorm > 0.045 && smoothedVolume > 0.02) {
                smoothedVocalX += (targetVocalX - smoothedVocalX) * 0.14;
            }

            // Spectral Peakness Detector: measures if the peak is a sharp vocal tone or flat noise/instrument chords
            // Look 2 bins away (instead of 1) to avoid adjacent-bin FFT energy leakage
            const valPrev = smoothedValues[vocalPeakBin - 2] || 0;
            const valNext = smoothedValues[vocalPeakBin + 2] || 0;
            const avgNeighbor = (valPrev + valNext) / 2;
            const peakiness = avgNeighbor > 1 ? (smoothedValues[vocalPeakBin] / avgNeighbor) : 1.0;
            // Limit minimum to 0.20 so the vocal wave never disappears entirely due to chord/percussion overlap
            const peakinessFactor = Math.max(0.20, Math.min(1.0, (peakiness - 1.05) * 1.8));

            // Height is coupled to pitch, volume (vocalAmpNorm), and spectral peakiness (clean vocal tone detector)
            let targetVocalAmp = (0.2 + 0.65 * pitchFactor) * Math.min(1.0, vocalAmpNorm * 5.0) * peakinessFactor; 
            if (smoothedVolume < 0.02) {
                targetVocalAmp = 0; // Fade out when the track is completely quiet/paused
            }
            smoothedVocalAmp += (targetVocalAmp - smoothedVocalAmp) * 0.18;



            const drawVocalWave = (vocalX: number, vocalAmp: number, opacityMultiplier: number, colorOffset: number, strokeWidth: number, bellWidth: number, heightScale: number, vocalPhase: number) => {
                canvasCtx.beginPath();
                const sampleStep = 8;
                const step = (width / (bufferLength - 1)) * sampleStep;
                const stepT = (1 / (bufferLength - 1)) * sampleStep;
                const stepVib1 = (35 / (bufferLength - 1)) * sampleStep;
                const stepVib2 = (85 / (bufferLength - 1)) * sampleStep;

                let prevX = 0;
                let prevY = baselineY;

                let currentX = 0;
                let currentT = 0;
                let argVib1 = vocalPhase * 3.0;
                let argVib2 = -vocalPhase * 5.0;

                for (let i = 0; i < bufferLength; i += sampleStep) {
                    const dist = currentT - vocalX;
                    const vocalBell = Math.exp(-(dist * dist) / (2 * bellWidth * bellWidth));
                    
                    // Strength-reduced sine argument tracking to avoid redundant multiplications inside loop
                    const primaryVib = Math.sin(argVib1);
                    const secondaryVib = Math.sin(argVib2) * 0.25;
                    const vibrato = ((primaryVib + secondaryVib) / 1.25) * 0.08 + 0.92;
                    
                    // Height is driven by vocal amplitude, bell shape, and vibrato (scaled to fill screen)
                    const currentHeight = vocalAmp * baselineY * heightScale * vocalBell * vibrato;
                    const limitedHeight = limitHeight(currentHeight, baselineY * 1.05);

                    const y = baselineY - limitedHeight;

                    if (i === 0) {
                        canvasCtx.moveTo(currentX, y);
                    } else {
                        const xc = (prevX + currentX) / 2;
                        const yc = (prevY + y) / 2;
                        canvasCtx.quadraticCurveTo(prevX, prevY, xc, yc);
                    }
                    prevX = currentX;
                    prevY = y;

                    currentX += step;
                    currentT += stepT;
                    argVib1 += stepVib1;
                    argVib2 += stepVib2;
                }
                canvasCtx.lineTo(prevX, prevY);

                const vocalLightness = 65 + smoothedVolume * 15; // 65% to 80% (extra bright glow on vocals)
                const strokeOpacity = Math.min(1.0, vocalAmp * 1.5) * opacityMultiplier;

                // Replace CPU-heavy shadowBlur with high-performance double-stroke hardware-accelerated neon glow simulation
                if (opacityMultiplier > 0.8) {
                    // 1. Draw colored outer glow aura
                    canvasCtx.strokeStyle = `hsla(${(baseHue + colorOffset) % 360}, 100%, ${vocalLightness}%, ${strokeOpacity * 0.45})`;
                    canvasCtx.lineWidth = strokeWidth + 6;
                    canvasCtx.stroke();

                    // 2. Draw white inner core
                    canvasCtx.strokeStyle = `rgba(255, 255, 255, ${strokeOpacity})`;
                    canvasCtx.lineWidth = strokeWidth;
                    canvasCtx.stroke();
                } else {
                    canvasCtx.strokeStyle = `hsla(${(baseHue + colorOffset) % 360}, 100%, 75%, ${strokeOpacity})`;
                    canvasCtx.lineWidth = strokeWidth;
                    canvasCtx.stroke();
                }

                // Close path for fill
                canvasCtx.lineTo(width, baselineY);
                canvasCtx.lineTo(0, baselineY);
                canvasCtx.closePath();

                // Subtle gradient fill under the vocal wave (defined over a shorter height to avoid banding)
                const gradientHeight = Math.min(300, height * 0.4);
                const gradient = canvasCtx.createLinearGradient(0, baselineY, 0, baselineY - gradientHeight);
                const targetOpacity = vocalAmp * 0.3 * opacityMultiplier;
                // Non-linear cubic-like curve: transitions opacity rapidly at the bottom to compress and hide banding
                gradient.addColorStop(0, `hsla(${(baseHue + colorOffset) % 360}, 100%, ${vocalLightness - 10}%, 0)`);
                gradient.addColorStop(0.06, `hsla(${(baseHue + colorOffset) % 360}, 100%, ${vocalLightness - 10}%, ${targetOpacity * 0.15})`);
                gradient.addColorStop(0.2, `hsla(${(baseHue + colorOffset) % 360}, 100%, ${vocalLightness - 10}%, ${targetOpacity * 0.4})`);
                gradient.addColorStop(0.55, `hsla(${(baseHue + colorOffset) % 360}, 100%, ${vocalLightness - 10}%, ${targetOpacity * 0.78})`);
                gradient.addColorStop(1, `hsla(${(baseHue + colorOffset) % 360}, 100%, ${vocalLightness - 10}%, ${targetOpacity})`);
                canvasCtx.fillStyle = gradient;
                canvasCtx.fill();
            };
            const drawWave = (offsetPhase: number, opacity: number, colorHue: number, heightMultiplier: number, wavePhase: number) => {
                canvasCtx.beginPath();
                const sampleStep = 8;
                const step = (width / (bufferLength - 1)) * sampleStep;
                const stepT = (1 / (bufferLength - 1)) * sampleStep;
                
                let prevX = 0;
                let prevY = baselineY;

                let currentX = 0;
                let currentT = 0;
                let argWave1 = wavePhase + offsetPhase;
                let argWave2 = -wavePhase * 1.5 + offsetPhase;
                let argWave3 = wavePhase * 4.0 - offsetPhase;
                const stepWave1 = waveDensity * sampleStep;
                const stepWave2 = waveDensity * 2.5 * sampleStep;
                const stepWave3 = waveDensity * 6.0 * sampleStep;

                let lookupIdx = 0;
                for (let i = 0; i < bufferLength; i += sampleStep) {
                    const { lowIndex, highIndex, frac } = logLookupTable[lookupIdx++];
                    const rawVal = smoothedValues[lowIndex] * (1 - frac) + smoothedValues[highIndex] * frac;

                    // Auto-gain normalized amplitude value
                    const valNorm = Math.min(1.0, (rawVal / 255) / maxVolumeTracked);

                    // 轻重: Base amplitude is scaled by normalized bin energy, smoothed volume, and heightMultiplier
                    const rawAmp = Math.pow(valNorm, 1.6) * baselineY * 2.3;
                    const amp = rawAmp * (0.2 + 0.8 * smoothedVolume) * heightMultiplier;

                    // Fractional Brownian Motion (fBm) wave approximation with primary, secondary, and tertiary harmonics
                    const primaryWave = Math.sin(argWave1);
                    const secondaryWave = Math.sin(argWave2) * 0.3;
                    const tertiaryWave = Math.sin(argWave3) * 0.08;
                    
                    const waveFactor = (primaryWave + secondaryWave + tertiaryWave) / 1.38; // normalize sum to [-1, 1]
                    const waveFactorNormalized = waveFactor * 0.5 + 0.5;
                    
                    const currentHeight = amp * (0.2 + 0.8 * waveFactorNormalized);
                    const limitedHeight = limitHeight(currentHeight, baselineY * 1.05);

                    const y = baselineY - limitedHeight;

                    if (i === 0) {
                        canvasCtx.moveTo(currentX, y);
                    } else {
                        const xc = (prevX + currentX) / 2;
                        const yc = (prevY + y) / 2;
                        canvasCtx.quadraticCurveTo(prevX, prevY, xc, yc);
                    }
                    prevX = currentX;
                    prevY = y;

                    currentX += step;
                    currentT += stepT;
                    argWave1 += stepWave1;
                    argWave2 += stepWave2;
                    argWave3 += stepWave3;
                }
                canvasCtx.lineTo(prevX, prevY);

                // Draw the stroke along the wave top to make it clear and sharp
                // Dynamic lightness modulates with volume: deep/cooler colors when quiet, bright hot colors when loud
                const strokeLightness = 48 + smoothedVolume * 18; // 48% to 66%
                canvasCtx.strokeStyle = `hsla(${colorHue}, 100%, ${strokeLightness}%, ${Math.min(1.0, opacity * 1.5)})`;
                canvasCtx.lineWidth = 3;
                canvasCtx.stroke();

                // Now close the path at the bottom to fill the area under the wave
                canvasCtx.lineTo(width, baselineY);
                canvasCtx.lineTo(0, baselineY);
                canvasCtx.closePath();

                // Create a smooth vertical gradient (defined over a shorter height to avoid banding)
                const fillLightness = 45 + smoothedVolume * 15; // 45% to 60%
                const gradientHeight = Math.min(300, height * 0.4);
                const gradient = canvasCtx.createLinearGradient(0, baselineY, 0, baselineY - gradientHeight);
                // Non-linear cubic-like curve: transitions opacity rapidly at the bottom to compress and hide banding
                gradient.addColorStop(0, `hsla(${colorHue}, 100%, ${fillLightness}%, 0)`);
                gradient.addColorStop(0.06, `hsla(${colorHue}, 100%, ${fillLightness}%, ${opacity * 0.15})`);
                gradient.addColorStop(0.2, `hsla(${colorHue}, 100%, ${fillLightness}%, ${opacity * 0.4})`);
                gradient.addColorStop(0.55, `hsla(${colorHue}, 100%, ${fillLightness}%, ${opacity * 0.78})`);
                gradient.addColorStop(1, `hsla(${colorHue}, 100%, ${fillLightness}%, ${opacity})`);
                canvasCtx.fillStyle = gradient;
                canvasCtx.fill();
            };

            // Draw 3 layers of overlapping waves with decoupled frequency band phases
            // Wave 1: Bass driven, Wave 2: Midrange driven, Wave 3: Treble driven
            drawWave(Math.PI, 0.2, (baseHue + 120) % 360, 0.7, phase1);
            drawWave(Math.PI / 2, 0.35, (baseHue + 60) % 360, 0.85, phase2);
            drawWave(0, 0.55, baseHue, 1.0, phase3);

            // Draw a synchronized colored glow aura underneath (Vocal driven, 0ms lag, wider bell, complementary neon color)
            drawVocalWave(smoothedVocalX, smoothedVocalAmp, 0.5, 140, 6.5, 0.24, 0.95, phaseVocal);

            // Draw dedicated main vocal melody line on top (Vocal driven, 0ms lag, white glow, colorOffset 180, sharp core)
            drawVocalWave(smoothedVocalX, smoothedVocalAmp, 1.0, 180, 4.0, 0.16, 1.05, phaseVocal);

            // Apply dynamic dither noise overlay ONCE over the entire drawn area of the frame to eliminate gradient banding
            if (noisePattern) {
                canvasCtx.save();
                canvasCtx.globalCompositeOperation = "source-atop";
                if (noiseMatrix && noisePattern.setTransform) {
                    noiseMatrix.e = Math.floor(Math.random() * 64);
                    noiseMatrix.f = Math.floor(Math.random() * 64);
                    noisePattern.setTransform(noiseMatrix);
                }
                canvasCtx.fillStyle = noisePattern;
                canvasCtx.fillRect(0, 0, width, height);
                canvasCtx.restore();
            }

            // Schedule the next frame for active 60fps rendering
            animationFrameId = requestAnimationFrame(draw);
        };

        // Sleep state polling machine: checks audio levels every 250ms when idle/paused
        const pollAudio = () => {
            analyserNode.getByteFrequencyData(dataArray);
            let frameMax = 0;
            for (let i = 0; i < bufferLength; i++) {
                if (dataArray[i] > frameMax) {
                    frameMax = dataArray[i];
                }
            }
            
            if (frameMax >= 2) {
                // Wake up! Sound detected, resume 60fps rendering
                silentFramesCount = 0;
                lastFrameTime = performance.now();
                animationFrameId = requestAnimationFrame(draw);
            } else {
                // Keep sleeping, poll again in 250ms
                sleepTimeoutId = window.setTimeout(pollAudio, 250);
            }
        };

        const scheduleSleepPoll = () => {
            if (sleepTimeoutId !== null) {
                window.clearTimeout(sleepTimeoutId);
            }
            sleepTimeoutId = window.setTimeout(pollAudio, 250);
        };

        // Initialize animation loop
        draw(performance.now());

        // Throttled resize handler to prevent lagging/reflow spikes during window resize
        let resizeAnimationFrameId: number | null = null;
        const handleResize = () => {
            if (resizeAnimationFrameId !== null) return;
            resizeAnimationFrameId = window.requestAnimationFrame(() => {
                const currentDpr = 1.0;
                width = window.innerWidth;
                height = window.innerHeight;
                baselineY = height - 64;
                canvas.width = width * currentDpr;
                canvas.height = height * currentDpr;
                canvasCtx.scale(currentDpr, currentDpr);
                resizeAnimationFrameId = null;
            });
        };
        window.addEventListener("resize", handleResize);

        // Page Visibility API Integration: Freeze all loops when the window is hidden/minimized
        const handleVisibilityChange = () => {
            if (document.hidden) {
                // Instantly suspend both 60fps rendering and the 250ms sleep-polling loops
                cancelAnimationFrame(animationFrameId);
                if (sleepTimeoutId !== null) {
                    window.clearTimeout(sleepTimeoutId);
                    sleepTimeoutId = null;
                }
            } else {
                // Resume loop check instantly when brought back to foreground
                pollAudio();
            }
        };
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            cancelAnimationFrame(animationFrameId);
            if (resizeAnimationFrameId !== null) {
                cancelAnimationFrame(resizeAnimationFrameId);
            }
            if (sleepTimeoutId !== null) {
                window.clearTimeout(sleepTimeoutId);
            }
            window.removeEventListener("resize", handleResize);
            document.removeEventListener("visibilitychange", handleVisibilityChange);

            // Restore original Web Audio AnalyserNode configurations to prevent side effects in other components/visualizers
            analyserNode.fftSize = originalFftSize;
            analyserNode.smoothingTimeConstant = originalSmoothing;
        };
    }, [analyserNode, playerState]);

    return <canvas ref={canvasRef} className="spectrum-visualizer" />;
};

export default SpectrumVisualizer;
