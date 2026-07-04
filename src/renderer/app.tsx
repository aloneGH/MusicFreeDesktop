import { useEffect, useState } from "react";
import AppHeader from "./components/Header";

import "./app.scss";
import MusicBar from "./components/MusicBar";
import { Outlet } from "react-router";
import PanelComponent from "./components/Panel";
import MusicDetail, { isMusicDetailShown, useMusicDetailShown } from "@renderer/components/MusicDetail";
import SpectrumVisualizer from "./components/SpectrumVisualizer";
import trackPlayer from "@renderer/core/track-player";
import { PlayerEvents } from "@renderer/core/track-player/enum";
import { IAudioController } from "@/types/audio-controller";
import { useUserPreference } from "@/renderer/utils/user-perference";

export default function App() {
    const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
    const musicDetailShown = useMusicDetailShown(); // Get the state of MusicDetail
    const [showSpectrum] = useUserPreference("showSpectrum");

    useEffect(() => {
        const onControllerReady = (controller: IAudioController) => {
            if (controller.getAnalyserNode) {
                const analyserNode = controller.getAnalyserNode();
                setAnalyser(analyserNode);
            }
        };

        if (trackPlayer.audioController.getAnalyserNode) {
            onControllerReady(trackPlayer.audioController);
        }

        trackPlayer.on(PlayerEvents.ControllerReady, onControllerReady);

        return () => {
            trackPlayer.off(PlayerEvents.ControllerReady, onControllerReady);
        };
    }, []);

    return (
        <>
            {analyser && (showSpectrum !== false) && <SpectrumVisualizer analyserNode={analyser} />}
            <div className="app-container">
                {/* Conditionally hide AppHeader and body-container content */}
                {!musicDetailShown && (
                    <>
                        <AppHeader></AppHeader>
                        <div className="body-container">
                            <Outlet></Outlet>
                            <PanelComponent></PanelComponent>
                        </div>
                    </>
                )}
                {/* MusicDetail is always rendered, but its visibility is managed internally */}
                <MusicDetail></MusicDetail>
                {/* MusicBar is always rendered */}
                <MusicBar></MusicBar>
            </div>
        </>
    );
}
