import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { logger } from '@/lib/logger';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(_request: Request) {
  const { searchParams } = new URL(_request.url);
  const concursoId = searchParams.get('concurso_id');

  const cookieStore = cookies();
  const supabase = createRouteHandlerClient({ cookies: () => cookieStore });

  try {
    // Verificar se o usuário está autenticado
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    // Construir a query base
    let query = supabase.from('apostilas').select('*');

    // Aplicar filtro por concurso se fornecido
    if (concursoId) {
      query = query.eq('concurso_id', concursoId);
    }

    // Executar a query
    const { data: apostilas, error } = await query;

    if (error) {
      logger.error('Erro ao buscar apostilas:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }

    // Buscar informações dos concursos separadamente se necessário
    if (apostilas && apostilas.length > 0) {
      const concursoIds = apostilas
        .map(a => a.concurso_id)
        .filter(id => id !== null) as string[];

      if (concursoIds.length > 0) {
        const { data: concursos, error: concursosError } = await supabase
          .from('concursos')
          .select('id, nome, categoria, ano, banca')
          .in('id', concursoIds);

        if (!concursosError && concursos) {
          const concursosMap = new Map(concursos.map(c => [c.id, c]));
          const apostilasComConcurso = apostilas.map(apostila => ({
            ...apostila,
            concursos: apostila.concurso_id
              ? concursosMap.get(apostila.concurso_id)
              : null,
          }));

          return NextResponse.json({
            apostilas: apostilasComConcurso,
          });
        }
      }
    }

    return NextResponse.json({
      apostilas,
    });
  } catch (error) {
    logger.error('Erro ao processar requisição:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(_request: Request) {
  const cookieStore = cookies();
  const supabase = createRouteHandlerClient({ cookies: () => cookieStore });

  try {
    // Verificar se o usuário está autenticado
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (!session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    // Obter os dados do corpo da requisição
    const body = await _request.json();
    const { title, description, url, concurso_id } = body;

    // Validar os dados obrigatórios
    if (!title || !url) {
      return NextResponse.json(
        { error: 'Título e URL são obrigatórios' },
        { status: 400 }
      );
    }

    // Criar a apostila
    const { data: apostila, error } = await supabase
      .from('apostilas')
      .insert({
        title,
        description,
        url,
        concurso_id,
      })
      .select()
      .single();

    if (error) {
      logger.error('Erro ao criar apostila:', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: 'Apostila criada com sucesso',
      apostila,
    });
  } catch (error) {
    logger.error('Erro ao processar requisição:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
