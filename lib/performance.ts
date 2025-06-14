import { createServerSupabaseClient } from './supabase';
import { logger } from '@/lib/logger';
import { CacheManager } from './cache';
import { getAuditLogger } from './audit';

export interface PerformanceStats {
  totalSimulados: number;
  totalQuestoes: number;
  totalStudyTime: number;
  averageScore: number;
  accuracyRate: number;
  weeklyProgress: {
    simulados: number;
    questoes: number;
    studyTime: number;
    scoreImprovement: number;
  };
  disciplineStats: DisciplinePerformance[];
}

export interface DisciplinePerformance {
  disciplina: string;
  totalQuestions: number;
  correctAnswers: number;
  averageScore: number;
  studyTime: number;
  lastActivity: string;
  progressPercentage: number;
}

export class PerformanceCalculator {
  private static instance: PerformanceCalculator;
  private supabase = createServerSupabaseClient();
  private cache = CacheManager.getInstance();
  private auditLogger = getAuditLogger();

  private constructor() {}

  public static getInstance(): PerformanceCalculator {
    if (!PerformanceCalculator.instance) {
      PerformanceCalculator.instance = new PerformanceCalculator();
    }
    return PerformanceCalculator.instance;
  }

  /**
   * Calcula estatísticas completas de desempenho do usuário
   */
  async calculateUserPerformance(userId: string): Promise<PerformanceStats> {
    const cacheKey = CacheManager.generatePerformanceKey(userId, 'complete');

    // Tentar obter do cache primeiro
    let stats = await this.cache.get<PerformanceStats>(userId, cacheKey);

    if (!stats) {
      // Calcular estatísticas
      const [simuladosStats, questoesStats, disciplineStats, weeklyProgress] =
        await Promise.all([
          this.calculateSimuladosStats(userId),
          this.calculateQuestoesStats(userId),
          this.calculateDisciplineStats(userId),
          this.calculateWeeklyProgress(userId),
        ]);

      stats = {
        totalSimulados: simuladosStats.total,
        totalQuestoes: questoesStats.total,
        totalStudyTime: simuladosStats.totalTime + questoesStats.totalTime,
        averageScore: simuladosStats.averageScore,
        accuracyRate: questoesStats.accuracyRate,
        weeklyProgress,
        disciplineStats,
      };

      // Salvar no cache por 15 minutos
      await this.cache.set(userId, cacheKey, stats, 15);
    }

    return stats;
  }

  /**
   * Calcula estatísticas de simulados
   */
  async calculateSimuladosStats(userId: string): Promise<{
    total: number;
    averageScore: number;
    totalTime: number;
  }> {
    const { data, error } = await this.supabase
      .from('user_simulado_progress')
      .select('score, time_taken_minutes')
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (error) {
      logger.error('Erro ao calcular estatísticas de simulados:', {
        error: error.message,
        details: error,
      });
      return { total: 0, averageScore: 0, totalTime: 0 };
    }

    const total = data.length;
    const totalScore = data.reduce((acc, item) => acc + item.score, 0);
    const totalTime = data.reduce(
      (acc, item) => acc + item.time_taken_minutes,
      0
    );
    const averageScore = total > 0 ? totalScore / total : 0;

    return { total, averageScore, totalTime };
  }

  /**
   * Calcula estatísticas de questões semanais
   */
  async calculateQuestoesStats(userId: string): Promise<{
    total: number;
    accuracyRate: number;
    totalTime: number;
  }> {
    const { data, error } = await this.supabase
      .from('user_questoes_semanais_progress')
      .select('score, answers')
      .eq('user_id', userId)
      .is('deleted_at', null);

    if (error) {
      logger.error('Erro ao calcular estatísticas de questões:', {
        error: error.message,
        details: error,
      });
      return { total: 0, accuracyRate: 0, totalTime: 0 };
    }

    const total = data.length;
    let correctAnswers = 0;
    let totalQuestions = 0;

    // Calcular taxa de acerto baseada nas respostas
    data.forEach(item => {
      if (item.answers && Array.isArray(item.answers)) {
        totalQuestions += item.answers.length;
        correctAnswers += item.answers.filter(
          (answer: Record<string, unknown>) => answer.correct === true
        ).length;
      }
    });

    const accuracyRate =
      totalQuestions > 0 ? (correctAnswers / totalQuestions) * 100 : 0;
    const totalTime = total * 2; // Estimativa de 2 minutos por questão

    return { total, accuracyRate, totalTime };
  }

  /**
   * Calcula estatísticas por disciplina
   */
  async calculateDisciplineStats(
    userId: string
  ): Promise<DisciplinePerformance[]> {
    const { data, error } = await this.supabase
      .from('user_discipline_stats')
      .select('*')
      .eq('user_id', userId)
      .order('last_activity', { ascending: false });

    if (error) {
      logger.error('Erro ao calcular estatísticas por disciplina:', {
        error: error.message,
        details: error,
      });
      return [];
    }

    return data.map(item => ({
      disciplina: item.disciplina,
      totalQuestions: item.total_questions,
      correctAnswers: item.correct_answers,
      averageScore: item.average_score,
      studyTime: item.study_time_minutes,
      lastActivity: item.last_activity,
      progressPercentage:
        item.total_questions > 0
          ? (item.correct_answers / item.total_questions) * 100
          : 0,
    }));
  }

  /**
   * Calcula progresso semanal
   */
  async calculateWeeklyProgress(userId: string): Promise<{
    simulados: number;
    questoes: number;
    studyTime: number;
    scoreImprovement: number;
  }> {
    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    // Buscar dados da semana atual
    const [simuladosData, questoesData] = await Promise.all([
      this.supabase
        .from('user_simulado_progress')
        .select('score, time_taken_minutes')
        .eq('user_id', userId)
        .gte('completed_at', weekAgo)
        .is('deleted_at', null),
      this.supabase
        .from('user_questoes_semanais_progress')
        .select('score')
        .eq('user_id', userId)
        .gte('completed_at', weekAgo)
        .is('deleted_at', null),
    ]);

    const simulados = simuladosData.data?.length || 0;
    const questoes = questoesData.data?.length || 0;
    const studyTime =
      simuladosData.data?.reduce(
        (acc, item) => acc + item.time_taken_minutes,
        0
      ) || 0;

    // Calcular melhoria de pontuação (comparar com semana anterior)
    const twoWeeksAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000
    ).toISOString();
    const weekAgo2 = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    const [previousWeekData, currentWeekData] = await Promise.all([
      this.supabase
        .from('user_simulado_progress')
        .select('score')
        .eq('user_id', userId)
        .gte('completed_at', twoWeeksAgo)
        .lt('completed_at', weekAgo2)
        .is('deleted_at', null),
      this.supabase
        .from('user_simulado_progress')
        .select('score')
        .eq('user_id', userId)
        .gte('completed_at', weekAgo)
        .is('deleted_at', null),
    ]);

    const previousWeekAvg =
      previousWeekData.data && previousWeekData.data.length > 0
        ? previousWeekData.data.reduce((acc, item) => acc + item.score, 0) /
          previousWeekData.data.length
        : 0;
    const currentWeekAvg =
      currentWeekData.data && currentWeekData.data.length > 0
        ? currentWeekData.data.reduce((acc, item) => acc + item.score, 0) /
          currentWeekData.data.length
        : 0;

    const scoreImprovement =
      previousWeekAvg > 0
        ? ((currentWeekAvg - previousWeekAvg) / previousWeekAvg) * 100
        : 0;

    return {
      simulados,
      questoes,
      studyTime,
      scoreImprovement,
    };
  }

  /**
   * Atualiza estatísticas de disciplina após atividade
   */
  async updateDisciplineStats(
    userId: string,
    disciplina: string,
    questionsAnswered: number,
    correctAnswers: number,
    studyTimeMinutes: number
  ): Promise<void> {
    try {
      const { data: existingStats } = await this.supabase
        .from('user_discipline_stats')
        .select('*')
        .eq('user_id', userId)
        .eq('disciplina', disciplina)
        .single();

      const now = new Date().toISOString();

      if (existingStats) {
        // Atualizar estatísticas existentes
        const newTotalQuestions =
          existingStats.total_questions + questionsAnswered;
        const newCorrectAnswers =
          existingStats.correct_answers + correctAnswers;
        const newAverageScore =
          newTotalQuestions > 0
            ? (newCorrectAnswers / newTotalQuestions) * 100
            : 0;
        const newStudyTime =
          existingStats.study_time_minutes + studyTimeMinutes;

        await this.supabase
          .from('user_discipline_stats')
          .update({
            total_questions: newTotalQuestions,
            correct_answers: newCorrectAnswers,
            average_score: newAverageScore,
            study_time_minutes: newStudyTime,
            last_activity: now,
            updated_at: now,
          })
          .eq('id', existingStats.id);
      } else {
        // Criar novas estatísticas
        await this.supabase.from('user_discipline_stats').insert({
          user_id: userId,
          disciplina,
          total_questions: questionsAnswered,
          correct_answers: correctAnswers,
          average_score:
            questionsAnswered > 0
              ? (correctAnswers / questionsAnswered) * 100
              : 0,
          study_time_minutes: studyTimeMinutes,
          last_activity: now,
        });
      }

      // Limpar cache relacionado
      await this.cache.delete(
        userId,
        CacheManager.generateDisciplineStatsKey(userId, disciplina)
      );
      await this.cache.delete(
        userId,
        CacheManager.generatePerformanceKey(userId, 'complete')
      );
    } catch (error) {
      logger.error('Erro ao atualizar estatísticas de disciplina:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Atualiza estatísticas gerais do usuário
   */
  async updateUserStats(
    userId: string,
    questionsAnswered: number,
    correctAnswers: number,
    studyTimeMinutes: number
  ): Promise<void> {
    try {
      const { data: user } = await this.supabase
        .from('users')
        .select(
          'total_questions_answered, total_correct_answers, study_time_minutes, average_score'
        )
        .eq('id', userId)
        .single();

      if (user) {
        const newTotalQuestions =
          user.total_questions_answered + questionsAnswered;
        const newCorrectAnswers = user.total_correct_answers + correctAnswers;
        const newStudyTime = user.study_time_minutes + studyTimeMinutes;
        const newAverageScore =
          newTotalQuestions > 0
            ? (newCorrectAnswers / newTotalQuestions) * 100
            : 0;

        await this.supabase
          .from('users')
          .update({
            total_questions_answered: newTotalQuestions,
            total_correct_answers: newCorrectAnswers,
            study_time_minutes: newStudyTime,
            average_score: newAverageScore,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);
      }

      // Limpar cache
      await this.cache.delete(
        userId,
        CacheManager.generatePerformanceKey(userId, 'complete')
      );
    } catch (error) {
      logger.error('Erro ao atualizar estatísticas do usuário:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Registra conclusão de simulado e atualiza estatísticas
   */
  async recordSimuladoCompletion(
    userId: string,
    simuladoId: string,
    score: number,
    timeTaken: number,
    answers: Record<string, unknown>[]
  ): Promise<void> {
    try {
      // Registrar no progresso
      await this.supabase.from('user_simulado_progress').insert({
        user_id: userId,
        simulado_id: simuladoId,
        score,
        time_taken_minutes: timeTaken,
        answers,
        completed_at: new Date().toISOString(),
      });

      // Atualizar estatísticas
      await this.updateUserStats(userId, 1, score > 50 ? 1 : 0, timeTaken);

      // Registrar no log de auditoria
      await this.auditLogger.logSimuladoComplete(
        userId,
        simuladoId,
        score,
        timeTaken
      );

      // Limpar cache
      await this.cache.delete(
        userId,
        CacheManager.generatePerformanceKey(userId, 'simulados')
      );
      await this.cache.delete(
        userId,
        CacheManager.generatePerformanceKey(userId, 'complete')
      );
    } catch (error) {
      logger.error('Erro ao registrar conclusão de simulado:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Registra conclusão de questões semanais e atualiza estatísticas
   */
  async recordQuestaoCompletion(
    userId: string,
    questaoId: string,
    score: number,
    answers: Record<string, unknown>[]
  ): Promise<void> {
    try {
      // Registrar no progresso
      await this.supabase.from('user_questoes_semanais_progress').insert({
        user_id: userId,
        questoes_semanais_id: questaoId,
        score,
        answers,
        completed_at: new Date().toISOString(),
      });

      // Calcular estatísticas das respostas
      const correctAnswers = answers.filter(
        (answer: Record<string, unknown>) => answer.correct === true
      ).length;
      const totalQuestions = answers.length;

      // Atualizar estatísticas
      await this.updateUserStats(
        userId,
        totalQuestions,
        correctAnswers,
        totalQuestions * 2
      ); // 2 min por questão

      // Atualizar estatísticas por disciplina (se disponível)
      // TODO: Extrair disciplina das questões

      // Registrar no log de auditoria
      await this.auditLogger.logQuestaoComplete(userId, questaoId, score);

      // Limpar cache
      await this.cache.delete(
        userId,
        CacheManager.generatePerformanceKey(userId, 'questoes')
      );
      await this.cache.delete(
        userId,
        CacheManager.generatePerformanceKey(userId, 'complete')
      );
    } catch (error) {
      logger.error('Erro ao registrar conclusão de questões:', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Função utilitária para obter instância do calculador
export const getPerformanceCalculator = () =>
  PerformanceCalculator.getInstance();
